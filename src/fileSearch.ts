/** Match tiers keep exact filenames ahead of fuzzy matches and recent files. */
function subsequence(text:string,query:string): number {
  let cursor=0,first=-1,last=-1;
  for(const character of query) { const index=text.indexOf(character,cursor);if(index<0)return -1;if(first<0)first=index;last=index;cursor=index+1; }
  return first+Math.max(0,last-first+1-query.length)*2;
}
export function rankWorkspaceFiles(files:string[],query:string,limit=40,recent:string[]=[]):string[] {
 const normalize=(value:string)=>value.replace(/\\/g,"/").toLocaleLowerCase();
 const needle=normalize(query);const recentOrder=new Map(recent.map((file,index)=>[normalize(file),index]));
 return [...new Set(files)].map(file=>{
  const full=normalize(file),name=full.slice(full.lastIndexOf("/")+1);
  let tier=!needle?0:name===needle?0:name.startsWith(needle)?1:name.includes(needle)?2:full.includes(needle)?3:4;
  let gap=0;if(needle&&tier===4){gap=subsequence(name,needle);if(gap<0){tier=5;gap=subsequence(full,needle);}}
  return {file,tier,gap,recent:recentOrder.get(full)??Infinity};
 }).filter(item=>item.gap>=0).sort((a,b)=>a.tier-b.tier||a.recent-b.recent||a.gap-b.gap||a.file.length-b.file.length||a.file.localeCompare(b.file)).slice(0,limit).map(item=>item.file);
}
function literal(character:string):string {
 if(/[a-z]/i.test(character))return `[${character.toLowerCase()}${character.toUpperCase()}]`;
 return /[\[\]{}*?]/.test(character)?`[${character}]`:character;
}
/** Targeted native searches avoid depending on the initial workspace listing. */
export function workspaceSearchPatterns(query:string):string[] {
 const segments=query.replace(/\\/g,"/").split("/").filter(Boolean);
 if(!segments.length)return ["**/*"];
 const exact=segments.map(segment=>[...segment].map(literal).join("")).join("/");
 const fuzzy=segments.map(segment=>"*"+[...segment].map(literal).join("*")+"*").join("/**/");
 if (/[/\\]$/.test(query)) return [`**/${exact}/**/*`,`**/${fuzzy}/**/*`];
 return [`**/${exact}`,`**/${fuzzy}`,`**/${fuzzy}/**/*`];
}
