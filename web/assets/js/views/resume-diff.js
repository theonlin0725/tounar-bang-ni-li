const cosmetic = /[\s\p{P}]/gu;

export function hasResumeDescriptionChange(original, rewritten) {
  return original.replace(cosmetic, '') !== rewritten.replace(cosmetic, '');
}
