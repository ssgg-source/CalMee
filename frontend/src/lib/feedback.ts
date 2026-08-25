import type { AppLocale } from '@/contexts/LanguageContext';

export type UserFacingError = {
  message: string;
  technicalDetail: string;
  code: 'network' | 'permission' | 'storage' | 'model' | 'configuration' | 'cancelled' | 'unexpected';
};

const errorText = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

/**
 * Converts native/provider failures into safe copy for the primary UI. The
 * original detail is retained for logs and future diagnostics, but is never
 * used as the visible toast description.
 */
export function toUserFacingError(error: unknown, locale: AppLocale): UserFacingError {
  const technicalDetail = errorText(error).trim() || 'Unknown error';
  const normalized = technicalDetail.toLowerCase();
  const zh = locale === 'zh-CN';

  if (/cancel|aborted|停止|取消/.test(normalized)) {
    return { code: 'cancelled', technicalDetail, message: zh ? '任务已取消。' : 'The task was cancelled.' };
  }
  if (/network|connection|timed?\s*out|fetch|dns|offline|http\s*5\d\d/.test(normalized)) {
    return { code: 'network', technicalDetail, message: zh ? '网络连接不稳定，请检查网络后重试。' : 'The network connection is unavailable. Check your connection and try again.' };
  }
  if (/permission|not authorized|access denied|operation not permitted/.test(normalized)) {
    return { code: 'permission', technicalDetail, message: zh ? 'CalMee 没有完成此操作所需的系统权限。' : 'CalMee does not have the system permission required for this action.' };
  }
  if (/disk|no space|storage|read-only file system|failed to write|io error/.test(normalized)) {
    return { code: 'storage', technicalDetail, message: zh ? '无法写入本机存储，请检查可用空间后重试。' : 'CalMee could not write to local storage. Check free space and try again.' };
  }
  if (/model|torch|python|runtime|checkpoint|tokenizer/.test(normalized)) {
    return { code: 'model', technicalDetail, message: zh ? '所选模型尚未准备好，请到“设置 → 转写”检查模型状态。' : 'The selected model is not ready. Check it in Settings → Transcription.' };
  }
  if (/api.?key|credential|unauthorized|forbidden|configuration|not configured/.test(normalized)) {
    return { code: 'configuration', technicalDetail, message: zh ? '当前服务配置无效，请在设置中检查后重试。' : 'The current service configuration is invalid. Check Settings and try again.' };
  }

  return {
    code: 'unexpected',
    technicalDetail,
    message: zh ? '操作未能完成，请稍后重试。' : 'The action could not be completed. Please try again.',
  };
}

export function reportTechnicalError(scope: string, error: unknown) {
  console.error(`[${scope}]`, error);
}

export function boundedPercentage(value: unknown): number | null {
  const percentage = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(percentage)) return null;
  return Math.max(0, Math.min(100, Math.round(percentage)));
}

export function progressDescription(stage: string, percentage: number | null) {
  if (percentage == null || percentage <= 0 || percentage >= 100) return stage;
  return `${stage} — ${percentage}%`;
}
