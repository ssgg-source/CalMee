"use client";

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductButton } from "@/components/ui/ProductControls";

export function ProductConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  details,
  confirmLabel,
  cancelLabel,
  destructive = false,
  loading = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description: React.ReactNode;
  details?: React.ReactNode;
  confirmLabel: React.ReactNode;
  cancelLabel: React.ReactNode;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={(value) => !loading && onOpenChange(value)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className={destructive
              ? "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-destructive/10 text-destructive"
              : "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"}
            >
              <AlertTriangle className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription className="mt-1.5">{description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        {details && <div className="rounded-lg bg-muted/45 px-3 py-2.5 text-[12px] leading-5 text-muted-foreground">{details}</div>}
        <DialogFooter>
          <ProductButton size="sm" onClick={() => onOpenChange(false)} disabled={loading}>{cancelLabel}</ProductButton>
          <ProductButton size="sm" variant={destructive ? "danger" : "primary"} onClick={() => void onConfirm()} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </ProductButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
