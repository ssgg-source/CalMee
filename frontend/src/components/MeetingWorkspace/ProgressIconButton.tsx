"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ProgressIconButton({
  icon,
  title,
  onClick,
  onCancel,
  disabled,
  progress,
  progressText,
  tone = "plain",
  className,
}: {
  icon: ReactNode;
  title: string;
  onClick: () => void;
  onCancel?: () => void;
  disabled?: boolean;
  progress?: number | null;
  progressText?: string;
  tone?: "plain" | "ai";
  className?: string;
}) {
  const running = progress != null;
  const indeterminate = running && progress < 0;
  const value = Math.max(0, Math.min(100, progress || 0));
  const circumference = 2 * Math.PI * 11;
  const tooltip = running
    ? `${progressText || title}${indeterminate ? "" : ` · ${Math.round(value)}%`}${onCancel ? " · 双击取消 / Double-click to cancel" : ""}`
    : title;
  return (
    <Button
      variant="outline"
      size="icon"
      className={cn(
        "relative h-9 w-9",
        running && onCancel && "cursor-pointer",
        tone === "ai" &&
          "border-violet-200 bg-gradient-to-br from-blue-50 to-violet-50 text-violet-700",
        className,
      )}
      title={tooltip}
      aria-label={tooltip}
      onClick={() => {
        if (!running) onClick();
      }}
      onDoubleClick={(event) => {
        if (running && onCancel) {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      disabled={disabled && !running}
    >
      {running ? (
        <>
          <svg
            className={cn("pointer-events-none absolute left-1/2 top-1/2 !h-7 !w-7 -translate-x-1/2 -translate-y-1/2 -rotate-90", indeterminate && "animate-spin")}
            viewBox="0 0 28 28"
          >
            <circle
              cx="14"
              cy="14"
              r="11"
              fill="none"
              stroke="currentColor"
              strokeOpacity=".13"
              strokeWidth="2.2"
            />
            <circle
              cx="14"
              cy="14"
              r="11"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeDasharray={indeterminate ? `${circumference * .25} ${circumference * .75}` : circumference}
              strokeDashoffset={indeterminate ? 0 : circumference * (1 - value / 100)}
            />
          </svg>
          {!indeterminate && <span className="relative z-10 flex h-full w-full items-center justify-center text-[9px] font-semibold leading-none tabular-nums">{Math.round(value)}</span>}
        </>
      ) : (
        icon
      )}
    </Button>
  );
}
