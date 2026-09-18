import type { ReactNode } from 'react'
import type { RichAction, RichTone } from './types'
import { Button } from '@/components/ui/button'

interface Props {
  type: string
  title: string
  tone?: RichTone
  actions?: RichAction[]
  children: ReactNode
}

export default function RichCard({
  type,
  title,
  tone = 'neutral',
  actions = [],
  children,
}: Props) {
  return (
    <section className={`crt-rich-card ${tone}`}>
      <div className="crt-rich-card-head">
        <div>
          <span>{type}</span>
          <h3>{title}</h3>
        </div>
      </div>
      <div className="crt-rich-card-body">{children}</div>
      {actions.length > 0 && (
        <div className="crt-rich-actions">
          {actions.map((action) => (
            <Button
              key={action.label}
              variant="glass"
              size="sm"
              onClick={action.onClick}
              className="text-xs h-7"
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </section>
  )
}
