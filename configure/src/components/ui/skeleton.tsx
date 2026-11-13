// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { cn } from "@/lib/utils"

function Skeleton({
  className,
  variant = "pulse",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: "pulse" | "shimmer" }) {
  return (
    <div
      className={cn(
        "rounded-md bg-muted",
        variant === "shimmer" ? "animate-shimmer" : "animate-pulse",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
