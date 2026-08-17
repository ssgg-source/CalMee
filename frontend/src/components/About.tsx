import React, { useEffect, useState } from "react";
import { getVersion } from '@tauri-apps/api/app';
import Image from 'next/image';
import { useLanguage } from '@/contexts/LanguageContext';

export function About() {
    const [currentVersion, setCurrentVersion] = useState('0.4.0');
    const { t } = useLanguage();

    useEffect(() => {
        getVersion().then(setCurrentVersion).catch(console.error);
    }, []);

    return (
        <div className="h-[80vh] space-y-5 overflow-y-auto p-5">
            <div className="text-center">
                <Image
                    src="icon_128x128.png"
                    alt={t('about.iconAlt')}
                    width={64}
                    height={64}
                    className="mx-auto mb-3"
                />
                <h1 className="text-xl font-bold text-gray-900">CalMee</h1>
                <p className="text-sm text-gray-500">{t('about.version', { version: currentVersion })}</p>
                <p className="mt-2 text-sm text-gray-600">{t('about.tagline')}</p>
                <p className="mt-1 text-xs text-gray-500">{t('about.development')}</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <Feature title={t('about.localTitle')} description={t('about.localDescription')} />
                <Feature title={t('about.modelsTitle')} description={t('about.modelsDescription')} />
                <Feature title={t('about.workflowTitle')} description={t('about.workflowDescription')} />
                <Feature title={t('about.memoryTitle')} description={t('about.memoryDescription')} />
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                {t('about.attribution')}
            </div>

            <div className="border-t border-gray-200 pt-3 text-center text-xs text-gray-400">
                {t('about.legal')}
            </div>
        </div>
    );
}

function Feature({ title, description }: { title: string; description: string }) {
    return (
        <div className="rounded-lg bg-gray-50 p-3">
            <h2 className="mb-1 text-sm font-semibold text-gray-900">{title}</h2>
            <p className="text-xs leading-relaxed text-gray-600">{description}</p>
        </div>
    );
}
