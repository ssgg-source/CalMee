import React, { useEffect, useState } from 'react';
import { Cloud, HardDrive, Mic2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useLanguage } from '@/contexts/LanguageContext';

export function SetupOverviewStep() {
  const { completeOnboarding, goToStep } = useOnboarding();
  const { locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const [isMac, setIsMac] = useState(false);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    const checkPlatform = async () => {
      try {
        const { platform } = await import('@tauri-apps/plugin-os');
        setIsMac(platform() === 'macos');
      } catch {
        setIsMac(navigator.userAgent.includes('Mac'));
      }
    };
    void checkPlatform();
  }, []);

  const choices = [
    { icon: Mic2, title: zh ? '先录音和记笔记' : 'Record and take notes first', description: zh ? '不需要先下载任何模型。' : 'No model download is required to get started.' },
    { icon: HardDrive, title: zh ? '按需选择本地模型' : 'Choose local models when needed', description: zh ? '模型可单独下载、加载和删除。' : 'Models can be downloaded, loaded, and removed individually.' },
    { icon: Cloud, title: zh ? '也可使用云端服务' : 'Cloud providers are also supported', description: zh ? '稍后可在设置中选择转写和总结服务。' : 'Choose transcription and summary providers later in Settings.' },
  ];

  const handleContinue = async () => {
    if (isMac) {
      goToStep(4);
      return;
    }
    setFinishing(true);
    try {
      await completeOnboarding();
      window.location.reload();
    } finally {
      setFinishing(false);
    }
  };

  return (
    <OnboardingContainer
      title={zh ? '选择适合你的使用方式' : 'Choose how you want to use CalMee'}
      description={zh ? '模型不是首次启动的必选项，随时可以在设置中配置。' : 'Models are optional during first run and can be configured at any time.'}
      step={2}
      totalSteps={isMac ? 3 : 2}
    >
      <div className="flex flex-col items-center space-y-8">
        <div className="w-full max-w-lg divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white px-5 shadow-sm">
          {choices.map(({ icon: Icon, title, description }) => (
            <div key={title} className="flex gap-4 py-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-50 text-violet-600"><Icon className="h-4 w-4" /></div>
              <div><h3 className="text-sm font-medium text-slate-900">{title}</h3><p className="mt-1 text-sm leading-5 text-slate-500">{description}</p></div>
            </div>
          ))}
        </div>
        <div className="w-full max-w-xs">
          <Button onClick={() => void handleContinue()} disabled={finishing} className="h-11 w-full bg-slate-900 text-white hover:bg-slate-800">
            {finishing ? (zh ? '正在进入 CalMee…' : 'Opening CalMee…') : isMac ? (zh ? '继续设置权限' : 'Continue to permissions') : (zh ? '开始使用' : 'Start using CalMee')}
          </Button>
        </div>
      </div>
    </OnboardingContainer>
  );
}
