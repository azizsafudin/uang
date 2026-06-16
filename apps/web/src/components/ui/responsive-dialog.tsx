"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"

/**
 * A responsive form container. On desktop it renders a centered modal; on mobile
 * (< 768px) it slides in from the right as a full-height sheet with a scrollable
 * body and a pinned footer. Both presentations are built on the same Base UI
 * dialog primitive, so the Root/Trigger/Close/Title/Description slots are shared
 * and only Content/Header/Body/Footer change shape.
 *
 * Expected form shape:
 *
 *   <ResponsiveDialog open={open} onOpenChange={setOpen}>
 *     <ResponsiveDialogContent>
 *       <ResponsiveDialogHeader>
 *         <ResponsiveDialogTitle>Title</ResponsiveDialogTitle>
 *       </ResponsiveDialogHeader>
 *       <form onSubmit={…} className="flex min-h-0 flex-1 flex-col">
 *         <ResponsiveDialogBody className="space-y-4">…fields…</ResponsiveDialogBody>
 *         <ResponsiveDialogFooter>…buttons…</ResponsiveDialogFooter>
 *       </form>
 *     </ResponsiveDialogContent>
 *   </ResponsiveDialog>
 */

function ResponsiveDialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="responsive-dialog" {...props} />
}

function ResponsiveDialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return (
    <DialogPrimitive.Trigger data-slot="responsive-dialog-trigger" {...props} />
  )
}

function ResponsiveDialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="responsive-dialog-close" {...props} />
}

function ResponsiveDialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="responsive-dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 supports-backdrop-filter:backdrop-blur-xs data-ending-style:opacity-0 data-starting-style:opacity-0",
        className
      )}
      {...props}
    />
  )
}

function ResponsiveDialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  const isMobile = useIsMobile()

  return (
    <DialogPrimitive.Portal data-slot="responsive-dialog-portal">
      <ResponsiveDialogOverlay />
      <DialogPrimitive.Popup
        data-slot="responsive-dialog-content"
        className={cn(
          "fixed z-50 flex flex-col overflow-hidden bg-popover bg-clip-padding text-sm text-popover-foreground outline-none",
          isMobile
            ? // Right-anchored full-height sheet.
              "inset-y-0 right-0 h-full w-full max-w-sm border-l shadow-lg transition duration-200 ease-in-out data-ending-style:translate-x-[2.5rem] data-ending-style:opacity-0 data-starting-style:translate-x-[2.5rem] data-starting-style:opacity-0"
            : // Centered desktop modal.
              "top-1/2 left-1/2 max-h-[85vh] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl ring-1 ring-foreground/10 duration-100 sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="responsive-dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3.5 right-4"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

function ResponsiveDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="responsive-dialog-header"
      className={cn("flex shrink-0 flex-col gap-1.5 px-6 pt-6 pb-4", className)}
      {...props}
    />
  )
}

function ResponsiveDialogBody({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="responsive-dialog-body"
      className={cn("min-h-0 flex-1 overflow-y-auto px-6 pt-1 pb-5", className)}
      {...props}
    />
  )
}

function ResponsiveDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="responsive-dialog-footer"
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t bg-muted/40 px-6 py-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function ResponsiveDialogTitle({
  className,
  ...props
}: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="responsive-dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function ResponsiveDialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="responsive-dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogClose,
  ResponsiveDialogOverlay,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
}
