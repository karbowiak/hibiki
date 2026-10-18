import { forwardRef, type HTMLAttributes } from "react"
import clsx from "clsx"

/** Shared material for select lists, action menus and rich dropdowns. Positioning belongs to the caller. */
export const DropdownSurface = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function DropdownSurface({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={clsx("app-overlay-surface ui-dropdown-surface", className)}
      {...props}
    />
  )
})
