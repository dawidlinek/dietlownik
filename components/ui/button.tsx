import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-cream)] disabled:pointer-events-none disabled:opacity-50",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-9 px-4 py-2",
        icon: "h-9 w-9",
        pill: "h-7 px-3.5 text-[13px] rounded-full",
        sm: "h-8 px-3 text-xs",
      },
      variant: {
        default:
          "bg-[var(--color-amber)] text-[var(--color-cream)] hover:bg-[var(--color-amber-deep)]",
        ghost:
          "bg-transparent text-[var(--color-ink-2)] hover:bg-[var(--color-oat)] hover:text-[var(--color-ink)]",
        link: "underline-offset-4 hover:underline text-[var(--color-ink)]",
        outline:
          "border border-[var(--color-bone)] bg-transparent text-[var(--color-ink)] hover:bg-[var(--color-oat)]",
      },
    },
  }
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ className, size, variant }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
