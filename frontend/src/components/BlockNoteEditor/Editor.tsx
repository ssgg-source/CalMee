"use client";

import { useEffect } from "react";
import type { PartialBlock, Block } from "@blocknote/core";
import { en, zh } from "@blocknote/core/locales";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import "@blocknote/shadcn/style.css";
import "@blocknote/core/fonts/inter.css";
import { useLanguage } from "@/contexts/LanguageContext";

interface EditorProps {
  initialContent?: Block[];
  onChange?: (blocks: Block[]) => void;
  editable?: boolean;
}

export default function Editor({ initialContent, onChange, editable = true }: EditorProps) {
  const { locale } = useLanguage();

  const editor = useCreateBlockNote({
    initialContent: initialContent as PartialBlock[] | undefined,
    dictionary: locale === "zh-CN" ? zh : en,
    heading: { levels: [1, 2, 3, 4] },
  }, [locale]);

  // Handle content changes
  useEffect(() => {
    if (!onChange) return;

    const handleChange = () => {
      onChange(editor.document);
    };

    const unsubscribe = editor.onChange(handleChange);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [editor, onChange]);

  return <div className="calmee-blocknote-editor calmee-blocknote-editor--summary calmee-editor-canvas"><BlockNoteView editor={editor} editable={editable} theme="light" /></div>;
}
