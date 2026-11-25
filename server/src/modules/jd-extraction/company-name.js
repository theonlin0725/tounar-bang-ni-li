// Display aliases only: verify model output against original evidence first.
const INSTA360 = /^(?:影石(?:创新)?(?:科技)?(?:股份有限公司|有限责任公司|有限公司)?(?:\s*[(（]\s*Insta360\s*[)）]|\s*Insta360)?|Insta360)$/i;

export function jdCompanyDisplayName(name) {
  return INSTA360.test(name) ? '影石' : name;
}
