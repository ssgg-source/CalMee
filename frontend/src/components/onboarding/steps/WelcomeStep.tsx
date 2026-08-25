import React from 'react';
import { Lock, Sparkles, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useLanguage } from '@/contexts/LanguageContext';

export function WelcomeStep() {
  const { goNext } = useOnboarding();
  const { locale } = useLanguage();
  const zh = locale === 'zh-CN';

  const features = [
    {
      icon: Lock,
      title: zh ? '录音、笔记和本地模型由你掌控' : 'You control recordings, notes, and local models',
    },
    {
      icon: Sparkles,
      title: zh ? '从录音、转写到 AI 会议纪要' : 'From recordings and transcripts to AI meeting notes',
    },
    {
      icon: Cpu,
      title: zh ? '兼容本地模型与多种云端服务' : 'Works with local models and multiple cloud providers',
    },
  ];

  return (
    <OnboardingContainer
      title={zh ? '欢迎使用 CalMee' : 'Welcome to CalMee'}
      description={zh ? '录音、会中笔记、转写与 AI 会议纪要，组成完整的会议工作流。' : 'A complete meeting workflow for recording, live notes, transcription, and AI meeting notes.'}
      step={1}
      hideProgress={true}
    >
      <div className="flex flex-col items-center space-y-10">
        {/* Divider */}
        <div className="w-16 h-px bg-gray-300" />

        {/* Features Card */}
        <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-sm p-6 space-y-4">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div key={index} className="flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                  <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center">
                    <Icon className="w-3 h-3 text-gray-700" />
                  </div>
                </div>
                <p className="text-sm text-gray-700 leading-relaxed">{feature.title}</p>
              </div>
            );
          })}
        </div>

        {/* CTA Section */}
        <div className="w-full max-w-xs space-y-3">
          <Button
            onClick={goNext}
            className="w-full h-11 bg-gray-900 hover:bg-gray-800 text-white"
          >
            {zh ? '开始设置' : 'Get started'}
          </Button>
          <p className="text-xs text-center text-gray-500">{zh ? '无需预先下载模型' : 'No model download required'}</p>
        </div>
      </div>
    </OnboardingContainer>
  );
}
