import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeDataChanges } from '@/lib/data-events';
import { invoke } from '@/lib/data-invoke';

export type CustomModelKind = 'transcription' | 'ai';
export type CustomModelProtocol = 'openai' | 'anthropic';

export type CustomModelProfile = {
  id: string;
  kind: CustomModelKind;
  protocol: CustomModelProtocol;
  displayName: string;
  endpoint: string;
  model: string;
  hasApiKey: boolean;
};

export function useCustomModelProfiles(kind: CustomModelKind) {
  const [profiles, setProfiles] = useState<CustomModelProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const token = ++sequence.current;
    setLoading(true);
    try {
      const value = await invoke<CustomModelProfile[]>('api_list_custom_model_profiles', { kind });
      if (token === sequence.current) setProfiles(value);
    } catch {
      // Keep the last good list on a transient read failure.
    } finally {
      if (token === sequence.current) setLoading(false);
    }
  }, [kind]);

  useEffect(() => { void refresh(); const off = subscribeDataChanges(['models'], () => { void refresh(); }); return () => { off(); sequence.current++; }; }, [refresh]);
  return { profiles, loading, refresh };
}
