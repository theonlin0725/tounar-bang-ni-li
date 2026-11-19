import { config } from '../../config.js';
import { judgeRecruitment } from './jev.js';
import { judgeRecruitmentFlash } from './flash.js';

/* 邮件/插件共用判断入口：调用方不再直接 import Jev。
 * - mail 的判断模式由 MAIL_INTAKE_JUDGE 控制，和插件互相独立；
 * - 默认 jev，保持现有部署兼容；flash 时复用 AI_API_* 的 OpenAI 兼容模型；
 * - MAIL_INTAKE_JUDGE_FALLBACK=jev 可在 Flash 技术失败时回退到 Jev（默认不静默回退）。 */

export function judgeModeFor(source) {
  return source === 'mail' ? config.mailIntakeJudge : config.pluginIntakeJudge;
}

export async function judgeIntake({ source, state, candidates = [] }) {
  const mode = judgeModeFor(source);
  if (mode === 'flash') {
    try {
      const judged = await judgeRecruitmentFlash({ state, candidates });
      return { ...judged, judge_mode: 'flash' };
    } catch (err) {
      if (config.mailIntakeJudgeFallback === 'jev' && source === 'mail') {
        const judged = await judgeRecruitment({ state, candidates });
        return { ...judged, judge_mode: 'jev_fallback', fallback_from: err?.code || 'AUTO_AI_UNAVAILABLE' };
      }
      throw err;
    }
  }
  const judged = await judgeRecruitment({ state, candidates });
  return { ...judged, judge_mode: 'jev' };
}
