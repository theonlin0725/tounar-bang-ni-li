// Public job pages only. Strip executable content, forms, embedded state and contact data.
export async function sanitizedSnapshot(page) {
  return page.evaluate(() => {
    const jobs=[];
    const collect=value=>{
      if(Array.isArray(value))return value.forEach(collect);
      if(!value||typeof value!=='object')return;
      if(value['@graph'])collect(value['@graph']);
      if([value['@type']].flat().includes('JobPosting'))jobs.push({
        '@type':'JobPosting',title:String(value.title||'').slice(0,200),description:String(value.description||'').replace(/<[^>]*>/g,' ').slice(0,5000),
        hiringOrganization:{name:String(value.hiringOrganization?.name||'').slice(0,200)},
        identifier:value.identifier?{value:String(typeof value.identifier==='string'?value.identifier:value.identifier.value||'').slice(0,100)}:null,
        jobLocation:value.jobLocation?{address:{addressLocality:String((Array.isArray(value.jobLocation)?value.jobLocation[0]:value.jobLocation)?.address?.addressLocality||'').slice(0,80)}}:null
      });
    };
    for(const script of document.querySelectorAll('script[type="application/ld+json"]'))try{collect(JSON.parse(script.textContent));}catch{}
    const copy=document.documentElement.cloneNode(true);
    // Freeze the rendered visibility and typography before discarding site CSS
    // (often megabytes of unrelated UI/fonts). These are observed computed
    // styles, not invented fixture markup. Offline replay cannot load assets.
    const originals=[document.documentElement,...document.documentElement.querySelectorAll('*')];
    const clones=[copy,...copy.querySelectorAll('*')];
    for(let i=0;i<clones.length;i++){
      const node=clones[i];
      if(!node.style||/^(SCRIPT|STYLE|SVG|PATH|META|LINK)$/.test(node.tagName))continue;
      const style=getComputedStyle(originals[i]);
      node.setAttribute('style',['display','visibility','font-size','font-weight','white-space'].map(key=>`${key}:${style.getPropertyValue(key)}`).join(';'));
    }
    for(const node of copy.querySelectorAll('script,style,noscript,svg,canvas,iframe,form,input,textarea,select,object,embed,link,base,meta[http-equiv]'))node.remove();
    const comments=document.createTreeWalker(copy,NodeFilter.SHOW_COMMENT);
    const remove=[];while(comments.nextNode())remove.push(comments.currentNode);
    for(const node of remove)node.remove();
    for(const node of copy.querySelectorAll('*'))for(const attr of [...node.attributes]){
      if(/^on/i.test(attr.name)||/token|session|auth|email|phone|user|account|value|nonce/i.test(attr.name)||attr.name==='src'||attr.name==='srcset')node.removeAttribute(attr.name);
      else if(['href','action'].includes(attr.name)){
        try{
          const u=new URL(attr.value,location.href);
          if(!/^https?:$/.test(u.protocol)){node.removeAttribute(attr.name);continue;}
          u.username='';u.password='';
          const clean=part=>{
            part.pathname=part.pathname.replace(/;(?:jsessionid|phpsessid|sessionid|sid)=[^/;?#]*/gi,'');
            for(const key of [...part.searchParams.keys()])if(/token|session|auth|email|phone|user|account|^(sid|code|state)$/i.test(key))part.searchParams.delete(key);
          };
          clean(u);
          if(/^#!?\//.test(u.hash)){const route=new URL(u.hash.replace(/^#!/,'#').slice(1),u.origin);clean(route);u.hash='#'+route.pathname+route.search;}else u.hash='';
          node.setAttribute(attr.name,u.href);
        }catch{node.removeAttribute(attr.name);}
      }
    }
    if(jobs.length){const script=document.createElement('script');script.type='application/ld+json';script.textContent=JSON.stringify(jobs).replace(/</g,'\\u003c');(copy.querySelector('head')||copy).append(script);}
    const safe=copy.outerHTML.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[redacted-email]').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[redacted-phone]').replace(/(?<!\d)(?:0\d{2,3}[- ]\d{7,8}|400[- ]\d{3}[- ]\d{4})(?!\d)/g,'[redacted-phone]');
    return '<!doctype html>\n'+safe;
  });
}
