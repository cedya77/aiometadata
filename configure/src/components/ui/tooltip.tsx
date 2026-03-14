import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

interface TooltipContextValue {
  onTouchTrigger: () => void
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null)

const Tooltip = ({
  children,
  open: _open,
  onOpenChange: _onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) => {
  const [open, setOpen] = React.useState(false)
  const touchOpenRef = React.useRef(false)

  // Dismiss on outside touch for touch-opened tooltips
  React.useEffect(() => {
    if (!open || !touchOpenRef.current) return

    const dismiss = () => {
      setOpen(false)
      touchOpenRef.current = false
    }

    // Small delay to avoid catching the same touch that opened the tooltip
    const setupTimeout = setTimeout(() => {
      document.addEventListener("touchstart", dismiss, { once: true })
    }, 10)

    return () => {
      clearTimeout(setupTimeout)
      document.removeEventListener("touchstart", dismiss)
    }
  }, [open])

  const onTouchTrigger = React.useCallback(() => {
    touchOpenRef.current = true
    setOpen(true)
  }, [])

  return (
    <TooltipContext.Provider value={{ onTouchTrigger }}>
      <TooltipPrimitive.Root
        open={open}
        onOpenChange={(isOpen) => {
          // On desktop hover, let Radix control open state
          // When touch-opened, ignore Radix hover events (dismiss handles closing)
          if (!touchOpenRef.current) {
            setOpen(isOpen)
          }
        }}
        {...props}
      >
        {children}
      </TooltipPrimitive.Root>
    </TooltipContext.Provider>
  )
}

const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ onPointerDown, ...props }, ref) => {
  const ctx = React.useContext(TooltipContext)

  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      onPointerDown={(e) => {
        if (e.pointerType === "touch") {
          ctx?.onTouchTrigger()
        }
        onPointerDown?.(e)
      }}
      {...props}
    />
  )
})
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-tooltip-content-transform-origin]",
      className
    )}
    {...props}
  />
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
