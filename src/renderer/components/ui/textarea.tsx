import * as React from 'react'
import { cn } from '@/lib/utils'

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[60px] w-full rounded-xl border border-black/[0.08] bg-white/70 px-3 py-2 text-xs text-[#1d1d1f] shadow-[inset_0_1px_1px_rgba(0,0,0,0.03)] backdrop-blur-md transition-all placeholder:text-[#86868b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]/40 focus-visible:border-[#0071e3] focus-visible:bg-white disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = 'Textarea'

export { Textarea }
