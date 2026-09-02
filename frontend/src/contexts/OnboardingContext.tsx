'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { invoke } from '@/lib/data-invoke';
import type { OnboardingPermissions, PermissionStatus } from '@/types/onboarding';

type StoredOnboardingStatus = {
  version: string;
  completed: boolean;
  current_step: number;
  model_status: {
    parakeet: string;
    summary: string;
    selected_summary_model?: string;
  };
  last_updated: string;
};

type OnboardingContextType = {
  currentStep: number;
  permissions: OnboardingPermissions;
  permissionsSkipped: boolean;
  goToStep: (step: number) => void;
  goNext: () => void;
  goPrevious: () => void;
  setPermissionStatus: (permission: keyof OnboardingPermissions, status: PermissionStatus) => void;
  setPermissionsSkipped: (skipped: boolean) => void;
  completeOnboarding: () => Promise<void>;
};

const defaultModelStatus: StoredOnboardingStatus['model_status'] = {
  parakeet: 'not_downloaded',
  summary: 'not_downloaded',
};

const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [currentStep, setCurrentStep] = useState(1);
  const [completed, setCompleted] = useState(false);
  const [permissions, setPermissions] = useState<OnboardingPermissions>({
    microphone: 'not_determined',
    systemAudio: 'not_determined',
    screenRecording: 'not_determined',
  });
  const [permissionsSkipped, setPermissionsSkipped] = useState(false);
  const modelStatusRef = useRef<StoredOnboardingStatus['model_status']>(defaultModelStatus);
  const loadedRef = useRef(false);
  const completingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void invoke<StoredOnboardingStatus | null>('get_onboarding_status')
      .then(status => {
        if (cancelled) return;
        if (status) {
          modelStatusRef.current = status.model_status || defaultModelStatus;
          setCompleted(status.completed);
          // Step 3 belonged to the removed automatic-download page.
          setCurrentStep(status.current_step === 3 ? 2 : Math.max(1, Math.min(status.current_step, 4)));
        }
        loadedRef.current = true;
      })
      .catch(error => {
        console.error('[Onboarding] Failed to load first-run status:', error);
        loadedRef.current = true;
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!loadedRef.current || completed || completingRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void invoke('save_onboarding_status_cmd', {
        status: {
          version: '2.0',
          completed: false,
          current_step: currentStep,
          model_status: modelStatusRef.current,
          last_updated: new Date().toISOString(),
        },
      }).catch(error => console.error('[Onboarding] Failed to save first-run status:', error));
    }, 400);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [completed, currentStep]);

  const completeOnboarding = useCallback(async () => {
    completingRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      await invoke('complete_onboarding');
      setCompleted(true);
    } finally {
      completingRef.current = false;
    }
  }, []);

  const setPermissionStatus = useCallback((permission: keyof OnboardingPermissions, status: PermissionStatus) => {
    setPermissions(current => ({ ...current, [permission]: status }));
  }, []);

  const goToStep = useCallback((step: number) => setCurrentStep(Math.max(1, Math.min(step, 4))), []);
  const goNext = useCallback(() => setCurrentStep(step => Math.min(step + 1, 4)), []);
  const goPrevious = useCallback(() => setCurrentStep(step => step === 4 ? 2 : Math.max(step - 1, 1)), []);

  return (
    <OnboardingContext.Provider value={{
      currentStep,
      permissions,
      permissionsSkipped,
      goToStep,
      goNext,
      goPrevious,
      setPermissionStatus,
      setPermissionsSkipped,
      completeOnboarding,
    }}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (!context) throw new Error('useOnboarding must be used within OnboardingProvider');
  return context;
}
