import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
        online:
          "bg-[#DCFCE7] text-[#16A34A] border-[#16A34A]/20 dark:bg-[#16A34A]/20 dark:text-[#4ADE80] [a&]:hover:bg-[#DCFCE7]/80",
        offline:
          "bg-[#FEE2E2] text-[#EF4444] border-[#EF4444]/20 dark:bg-[#EF4444]/20 dark:text-[#F87171] [a&]:hover:bg-[#FEE2E2]/80",
        soon:
          "bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]/20 dark:bg-[#F59E0B]/20 dark:text-[#FBBF24] [a&]:hover:bg-[#FEF3C7]/80",
        blue:
          "bg-[#EFF6FF] text-[#3B82F6] border-[#3B82F6]/20 dark:bg-[#3B82F6]/20 dark:text-[#60A5FA] [a&]:hover:bg-[#EFF6FF]/80",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
