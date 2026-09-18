import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 select-none leading-normal',
  {
    variants: {
      variant: {
        default:
          'border border-[#0071e3]/20 bg-[#0071e3]/10 text-[#0071e3]',
        secondary:
          'border border-black/[0.06] bg-black/[0.04] text-[#86868b]',
        success:
          'border border-emerald-500/20 bg-emerald-500/10 text-emerald-700',
        warning:
          'border border-amber-500/20 bg-amber-500/10 text-amber-700',
        destructive:
          'border border-rose-500/20 bg-rose-500/10 text-rose-700',
        glass:
          'border border-white/60 bg-white/70 backdrop-blur-md text-[#1d1d1f] shadow-sm',
        outline:
          'border border-black/[0.12] text-[#1d1d1f]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
