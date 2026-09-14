function isExplicitLinkedInResearch(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value.includes('linkedin')) return false;
  const action = ['find','search','research','source','collect','bring','list','add','continue','resume'].some(word => value.includes(word));
  const target = ['company','companies','job','jobs','role','roles','lead','leads','profile','profiles','recruiter','recruiters'].some(word => value.includes(word));
  return action && target;
}

module.exports = { isExplicitLinkedInResearch };
