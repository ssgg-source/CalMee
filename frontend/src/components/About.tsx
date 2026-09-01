import React, { useEffect, useState } from "react";
import { getVersion } from '@tauri-apps/api/app';
import Image from 'next/image';
import { useLanguage } from '@/contexts/LanguageContext';
import { ProductPanel } from '@/components/ui/ProductControls';
import { reportTechnicalError } from '@/lib/feedback';

export function About() {
    const [currentVersion, setCurrentVersion] = useState(process.env.NEXT_PUBLIC_APP_VERSION ?? 'development');
    const { t } = useLanguage();

    useEffect(() => {
        getVersion().then(setCurrentVersion).catch((error) => reportTechnicalError('About.getVersion', error));
    }, []);

    return (
        <div className="space-y-5">
            <ProductPanel className="p-7 text-center">
                <Image
                    src="/icon_128x128.png"
                    alt={t('about.iconAlt')}
                    width={64}
                    height={64}
                    className="mx-auto mb-3"
                />
                <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-foreground">CalMee</h2>
                <p className="mt-1 text-[12px] text-muted-foreground">{t('about.version', { version: currentVersion })}</p>
                <p className="mt-3 text-[14px] text-foreground/80">{t('about.tagline')}</p>
                <p className="mt-1 text-[12px] text-muted-foreground">{t('about.development')}</p>
            </ProductPanel>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Feature title={t('about.localTitle')} description={t('about.localDescription')} />
                <Feature title={t('about.modelsTitle')} description={t('about.modelsDescription')} />
                <Feature title={t('about.workflowTitle')} description={t('about.workflowDescription')} />
                <Feature title={t('about.memoryTitle')} description={t('about.memoryDescription')} />
            </div>

            <ProductPanel className="p-4 text-[12px] leading-5 text-muted-foreground">
                {t('about.attribution')}
            </ProductPanel>

            <div className="pt-2 text-center text-[11px] text-muted-foreground">
                {t('about.legal')}
            </div>
        </div>
    );
}

function Feature({ title, description }: { title: string; description: string }) {
    return (
        <ProductPanel className="p-4">
            <h3 className="mb-1 text-[13px] font-semibold text-foreground">{title}</h3>
            <p className="text-[12px] leading-5 text-muted-foreground">{description}</p>
        </ProductPanel>
    );
}
