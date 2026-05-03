import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none",
  {
    defaultVariants: { variant: "default" },
    variants: {
      variant: {
        default: "bg-[var(--color-amber-tint)] text-[var(--color-ink)]",
        muted: "bg-[var(--color-oat)] text-[var(--color-ink-2)]",
        outline: "border border-[var(--color-bone)] text-[var(--color-ink-2)]",
      },
    },
  }
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = ({ className, variant, ...props }: BadgeProps) => (
  <span className={cn(badgeVariants({ variant }), className)} {...props} />
);

export { Badge, badgeVariants };
