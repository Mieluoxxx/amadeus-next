import type { ReactNode } from 'react'
import { translateDynamic, useI18n } from '../../i18n'

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-field-row">
      <div className="settings-field-label">{label}</div>
      <div className="settings-field-control">{children}</div>
    </div>
  )
}

export function Card({ title, status, children }: { title?: ReactNode; status?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-card">
      {title ? <div className="settings-card-header"><span className="settings-card-title">{title}</span>{status}</div> : null}
      {children}
    </div>
  )
}

export type ComboOption = string | { value: string; label: string }

export function ComboSelect({ value, onChange, options, disabled, label }: {
  value: string; onChange: (v: string) => void; options: ComboOption[]; disabled?: boolean; label: string
}) {
  const { locale } = useI18n()
  return (
    <select className="settings-select" aria-label={label} value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>
      {options.map(option => {
        const optionValue = typeof option === 'string' ? option : option.value
        const optionLabel = typeof option === 'string' ? option || 'default' : option.label
        return <option key={optionValue} value={optionValue}>{translateDynamic(locale, 'settings.option', optionValue, optionLabel)}</option>
      })}
    </select>
  )
}

export function IconAction({ label, glyph, busy = false, danger = false, disabled, onClick }: {
  label: string; glyph: string; busy?: boolean; danger?: boolean; disabled?: boolean; onClick: () => void
}) {
  return (
    <button type="button" className="settings-icon-button" data-danger={danger || undefined} onClick={onClick} disabled={disabled} title={label} aria-label={label}>
      <span aria-hidden="true">{busy ? '…' : glyph}</span>
    </button>
  )
}
