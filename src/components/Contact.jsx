import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import axios from 'axios'
import CirculationCanvas from './effects/CirculationCanvas'
import logoMark from '../assets/design/logo-mark.webp'
import useContent from '../content/useContent'
import { formatPhone } from '../data/content'
import { frontendError } from '../errors.js'
import { METRICA_GOALS } from '../../shared/analytics.js'
import { collectAttribution } from '../analytics/attribution.js'
import { reachGoal } from '../analytics/metrica.js'
import {
  MESSAGE_MAX,
  NAME_MAX,
  NAME_MIN,
  NAME_PATTERN,
  PHONE_PATTERN,
  clearLeadIdempotencyKey,
  collapseWhitespace,
  normalizePhone,
  resolveLeadIdempotencyKey,
} from '../../shared/lead.js'

// Заявка уходит на собственный серверный эндпоинт, а не напрямую в Telegram:
// токен бота не должен существовать в клиентском бандле.
const LEAD_ENDPOINT = import.meta.env.VITE_LEAD_ENDPOINT || '/api/lead'
// Строго больше серверного таймаута (8 с) плюс накладные расходы: иначе axios
// обрывал соединение раньше, чем сервер успевал ответить 504.
const REQUEST_TIMEOUT_MS = 15_000

// sessionStorage может быть запрещён политикой браузера, и обращение к нему
// бросает ещё до чтения. Тогда форма работает без ключа между перезагрузками.
const leadStorage = () => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

// Схема на уровне модуля. Правила берутся из общего модуля, чтобы клиент
// и сервер не разъезжались в трактовке длин и допустимых символов.
const scheme = z.object({
  name: z
    .string()
    .transform(collapseWhitespace)
    .refine((value) => value.length >= NAME_MIN && value.length <= NAME_MAX, {
      message: 'form.err.name',
    })
    .refine((value) => NAME_PATTERN.test(value), { message: 'form.err.name' }),
  phone: z
    // Пользователи пишут номер с пробелами, скобками и дефисами — нормализуем.
    .string()
    .transform(normalizePhone)
    .refine((digits) => PHONE_PATTERN.test(digits), { message: 'form.err.phone' }),
  message: z
    .string()
    .transform(collapseWhitespace)
    .refine((value) => value.length <= MESSAGE_MAX, { message: 'form.err.message' })
    .optional(),
})

// Коды ошибок сервера → ключи перевода. Раньше всё схлопывалось в одну строку,
// и упёршийся в лимит пользователь просто продолжал ретраить.
const PUBLIC_ERROR_KEYS = {
  rate_limited: 'formsent.rateLimited',
  not_configured: 'formsent.notConfigured',
  network_error: 'formsent.network',
  payload_too_large: 'formsent.tooLarge',
  delivery_unknown: 'formsent.deliveryUnknown',
  telegram_failed: 'formsent.error',
  validation_failed: 'formsent.validation',
  server_error: 'formsent.error',
}

const Contact = () => {
  const { t, i18n } = useTranslation()
  const { phones, form } = useContent()
  const [status, setStatus] = useState({
    text: '',
    error: false,
    requestId: '',
    technicalCode: '',
  })

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(scheme) })

  const onSubmit = async (values) => {
    if (form.requireMessage && !collapseWhitespace(values.message)) {
      setError('message', { type: 'required', message: 'form.err.messageRequired' })
      return
    }

    setStatus({
      text: t('formsent.sending'),
      error: false,
      requestId: '',
      technicalCode: '',
    })
    const storage = leadStorage()
    try {
      // Язык и страницу сервер пишет в журнал заявок: без них менеджер
      // перезванивает арабскому посетителю по-русски, а понять, с какого
      // раздела пришла заявка, нельзя вовсе.
      const payload = {
        ...values,
        locale: i18n.resolvedLanguage || i18n.language,
        pagePath: typeof window !== 'undefined' ? window.location.pathname : undefined,
      }
      // Атрибуция добавляется ПОСЛЕ сборки payload и не участвует
      // в отпечатке идемпотентности: resolveLeadIdempotencyKey считает ключ
      // по payload, а метки визита к содержимому заявки не относятся —
      // иначе повтор той же заявки по другой ссылке создал бы дубль.
      const attribution = await collectAttribution()
      // CR-033. Ключ привязан к содержимому формы и лежит в sessionStorage,
      // поэтому повтор после таймаута, обрыва связи, 5xx или delivery_unknown —
      // хоть кнопкой, хоть после перезагрузки страницы — попадает в уже
      // созданную заявку. Правка любого значимого поля меняет отпечаток
      // и выдаёт новый ключ, а повторный клик по той же форме — нет.
      const idempotencyKey = resolveLeadIdempotencyKey({ storage, payload })

      const { data } = await axios.post(LEAD_ENDPOINT, { ...payload, attribution }, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      })

      // Успех подтверждается ответом сервера, а не отсутствием исключения:
      // иначе страница-заглушка с HTTP 200 выглядела бы как принятая заявка.
      if (!data?.ok) {
        const failure = new Error(data?.error || 'lead_failed')
        failure.leadCode = data?.error
        throw failure
      }

      // Ключ снимается только по подтверждённой доставке: до неё он —
      // единственное, что отличает повтор от второй заявки.
      if (data.deliveryState === 'sent') clearLeadIdempotencyKey(storage)

      // Цель — по подтверждённому приёму на сервере, а не по клику: иначе
      // в конверсию попадали бы заявки, которые не дошли, и отчёт расходился
      // бы со списком заявок в админке. Повтор (duplicate) целью не считаем —
      // это та же заявка, отправленная второй раз.
      if (!data.duplicate) {
        reachGoal(METRICA_GOALS.FORM_SUBMIT, { locale: payload.locale })
      }

      reset()
      setStatus({
        text: t('formsent.success'),
        error: false,
        requestId: '',
        technicalCode: '',
      })
    } catch (error) {
      // Не логируем Axios error: его config содержит JSON-тело формы с именем
      // и телефоном. Для диагностики достаточно безопасного кода и request ID.
      const model = frontendError(error)
      // Сервер знает этот ключ за другой заявкой — значит, состояние формы
      // и хранилища разошлись. Забываем ключ, чтобы следующая отправка была
      // честной новой заявкой, а не бесконечным конфликтом.
      if (model.technicalCode === 'idempotency_conflict') clearLeadIdempotencyKey(storage)
      const key = PUBLIC_ERROR_KEYS[model.code]
      setStatus({
        text: key ? t(key, { defaultValue: `${model.message} ${model.action}` }) : model.message,
        error: true,
        requestId: model.requestId,
        technicalCode: model.technicalCode,
      })
    }
  }

  return (
    <section id="communication" className="pv-section pv-section--contact">
      <div className="pv-contact">
        <div data-reveal className="pv-contact__card pv-glass pv-glass--strong">
          <h2>{t('form.h2')}</h2>
          <p>{t('form.lead')}</p>
          <div className="pv-phones">
            {phones.map((phone) => (
              <a
                key={phone}
                href={`tel:${phone}`}
                onClick={() => reachGoal(METRICA_GOALS.PHONE_CLICK, { place: 'contact' })}
              >
                {formatPhone(phone)}
              </a>
            ))}
          </div>
        </div>

        <div data-reveal className="pv-circulate pv-glass pv-glass--strong">
          <span className="pv-circulate__glow pv-circulate__glow--cold" aria-hidden="true" />
          <span className="pv-circulate__glow pv-circulate__glow--warm" aria-hidden="true" />
          <div className="pv-circulate__stage">
            <CirculationCanvas />
            <div className="pv-circulate__badge">
              {/* Ширину задаёт CSS (74% круга), а width/height нужны браузеру
                  для пропорции: без них значок появляется рывком. */}
              <img src={logoMark} alt="PROHVAC" width="512" height="288" loading="lazy" />
            </div>
          </div>
          <p className="pv-circulate__caption">{t('form.caption')}</p>
        </div>

        <div data-reveal className="pv-form-card pv-glass">
          {/* ym-hide-content на полях — обязательное требование, а не украшение.
              Вебвизор включён (webvisor:true в сниппете) и по умолчанию пишет
              содержимое страницы вместе с вводом; без этого класса имя,
              телефон и текст заявки уезжали бы в записи визитов на серверах
              Яндекса. Авто-распознавание конфиденциальных полей Метрикой
              не гарантировано, полагаться на него нельзя. В интерфейсе
              счётчика при этом должна быть выключена запись всех полей. */}
          {/* Второй обработчик гасит статус прошлой отправки: иначе зелёное
              «Успешно отправлено» висело под формой, пока пользователь правит
              ошибки уже в следующей заявке. */}
          <form
            className="pv-form"
            onSubmit={handleSubmit(onSubmit, () =>
              setStatus({ text: '', error: false, requestId: '', technicalCode: '' })
            )}
            noValidate
          >
            <div className="pv-field">
              <label htmlFor="lead-name">{t('form.name')}</label>
              <input
                id="lead-name"
                type="text"
                className={`pv-input ym-hide-content${errors.name ? ' pv-input--invalid' : ''}`}
                placeholder={t('form.name')}
                autoComplete="name"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'lead-name-error' : undefined}
                {...register('name')}
              />
              {errors.name && (
                <span id="lead-name-error" className="pv-error" role="alert">
                  {t(errors.name.message)}
                </span>
              )}
            </div>

            <div className="pv-field">
              <label htmlFor="lead-phone">{t('form.phone')}</label>
              <input
                id="lead-phone"
                type="tel"
                className={`pv-input ym-hide-content${errors.phone ? ' pv-input--invalid' : ''}`}
                placeholder="+___ ___ ___ ____"
                autoComplete="tel"
                inputMode="tel"
                aria-invalid={Boolean(errors.phone)}
                aria-describedby={errors.phone ? 'lead-phone-error' : undefined}
                {...register('phone')}
              />
              {errors.phone && (
                <span id="lead-phone-error" className="pv-error" role="alert">
                  {t(errors.phone.message)}
                </span>
              )}
            </div>

            <div className="pv-field">
              <label htmlFor="lead-message">{t('form.message')}</label>
              <textarea
                id="lead-message"
                rows={4}
                className={`pv-input ym-hide-content${errors.message ? ' pv-input--invalid' : ''}`}
                placeholder={t('form.message')}
                required={form.requireMessage}
                aria-invalid={Boolean(errors.message)}
                aria-describedby={errors.message ? 'lead-message-error' : undefined}
                {...register('message')}
              />
              {errors.message && (
                <span id="lead-message-error" className="pv-error" role="alert">
                  {t(errors.message.message)}
                </span>
              )}
            </div>

            {/* Блокируем только на время отправки, чтобы автозаполнение
                браузера не оставляло кнопку неактивной. */}
            <button type="submit" className="pv-btn pv-btn--coral" disabled={isSubmitting}>
              {isSubmitting && <span className="pv-spinner" aria-hidden="true" />}
              {isSubmitting ? t('formsent.sending') : t('form.btn')}
            </button>

            <p className="pv-form__privacy">{t('form.privacy')}</p>

            <p
              className={`pv-status${status.error ? ' pv-status--error' : ''}`}
              role="status"
              aria-live="polite"
            >
              {status.text}
            </p>
            {status.error && (status.requestId || status.technicalCode) ? (
              <p className="pv-status__diagnostic">
                {status.requestId ? `Request ID: ${status.requestId}` : null}
                {status.requestId && status.technicalCode ? ' · ' : null}
                {status.technicalCode ? `Код: ${status.technicalCode}` : null}
              </p>
            ) : null}
          </form>
        </div>
      </div>
    </section>
  )
}

export default Contact
