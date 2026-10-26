export function classifyField(expected, actual) {
  if (!expected) return actual ? 'incorrect' : 'not_provided';
  if (!actual) return 'missing';
  return actual === expected ? 'correct' : 'incorrect';
}
export const validField = result => ['correct','not_provided'].includes(result);
