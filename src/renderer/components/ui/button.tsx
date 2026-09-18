import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-xs font-semibold ring-offset-background transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 select-none active:scale-[0.98]',
  {
    variants: {
      variant: {
        default:
          'bg-[#0071e3] text-white shadow-[0_1px_2px_rgba(0,113,227,0.25)] hover:bg-[#0077ED]',
        secondary:
          'bg-black/[0.05] text-[#1d1d1f] hover:bg-black/[0.08] hover:text-black',
        glass:
          'bg-white/70 text-[#1d1d1f] backdrop-blur-md border border-black/[0.06] shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:bg-white/90 hover:border-black/[0.1]',
        outline:
          'border border-black/[0.12] bg-white/40 text-[#1d1d1f] backdrop-blur-sm hover:bg-white/80 hover:border-black/[0.18]',
        ghost:
          'text-[#1d1d1f] hover:bg-black/[0.05] hover:text-black',
        destructive:
          'bg-[#ff3b30] text-white shadow-[0_1px_2px_rgba(255,59,48,0.25)] hover:bg-[#ff453a]',
        link:
          'text-[#0071e3] underline-offset-4 hover:underline',
        pill:
          'rounded-full bg-white/80 text-[#1d1d1f] border border-black/[0.06] shadow-sm backdrop-blur-md hover:bg-white',
      },
      size: {
        default: 'h-8 px-3.5 py-1.5',
        sm: 'h-7 rounded-lg px-2.5 text-[11px]',
        lg: 'h-10 rounded-xl px-5 text-sm',
        icon: 'h-8 w-8 rounded-lg p-0',
        'icon-sm': 'h-7 w-7 rounded-md p-0',
        'icon-lg': 'h-9 w-9 rounded-xl p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        data-slot="button"
        data-variant={variant || 'default'}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
