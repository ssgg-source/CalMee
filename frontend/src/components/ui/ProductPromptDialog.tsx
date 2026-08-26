"use client";

import { useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProductButton, ProductInput } from "@/components/ui/ProductControls";

export function ProductPromptDialog({ open, onOpenChange, title, description, value, onValueChange, placeholder, confirmLabel, cancelLabel, onConfirm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  confirmLabel: React.ReactNode;
  cancelLabel: React.ReactNode;
  onConfirm: () => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) window.requestAnimationFrame(() => inputRef.current?.focus()); }, [open]);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>{title}</DialogTitle>{description&&<DialogDescription>{description}</DialogDescription>}</DialogHeader><ProductInput ref={inputRef} className="w-full" value={value} onChange={event=>onValueChange(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&value.trim())void onConfirm();}} placeholder={placeholder}/><DialogFooter><ProductButton onClick={()=>onOpenChange(false)}>{cancelLabel}</ProductButton><ProductButton variant="primary" disabled={!value.trim()} onClick={()=>void onConfirm()}>{confirmLabel}</ProductButton></DialogFooter></DialogContent></Dialog>;
}
