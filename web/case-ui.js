// Session-only case state. No browser storage or network access.
const $=id=>document.getElementById(id);
const tabs=[$('portfolioTab'),$('caseTab'),$('guidelinesTab')];
export function selectTab(selected){
  if(selected!==$('portfolioTab') && !$('portfolioPanel').hidden){
    $('portfolioPanel').dispatchEvent(new Event('leaveportfolio'));
  }
  for(const tab of tabs){
    const active=tab===selected;
    tab.setAttribute('aria-selected',String(active));
    tab.tabIndex=active?0:-1;
    $(tab.getAttribute('aria-controls')).hidden=!active;
  }
}
for(const [index,tab] of tabs.entries()){
  tab.addEventListener('click',()=>selectTab(tab));
  tab.addEventListener('keydown',event=>{
    let next;
    if(event.key==='ArrowRight')next=tabs[(index+1)%tabs.length];
    if(event.key==='ArrowLeft')next=tabs[(index+tabs.length-1)%tabs.length];
    if(event.key==='Home')next=tabs[0];
    if(event.key==='End')next=tabs.at(-1);
    if(next){event.preventDefault();selectTab(next);next.focus();}
  });
}
const labels={
  'not-set':'Not set',drafting:'Drafting',ready:'Ready for submission',
  submitted:'Submitted',withdrawn:'Withdrawn'
};
let submissionStatus='not-set';
let portfolioStatus=null;
$('submissionStatus').value=submissionStatus;
$('submissionStatus').addEventListener('change',()=>{
  submissionStatus=Object.hasOwn(labels,$('submissionStatus').value)?$('submissionStatus').value:'not-set';
});
export function startSubmission(id, boundStatus=null){
  submissionStatus='not-set';
  portfolioStatus=boundStatus;
  $('submissionStatus').value=submissionStatus;
  $('standaloneStatus').hidden=boundStatus!==null;
  $('boundStatus').hidden=boundStatus===null;
  $('boundStatus').textContent=boundStatus===null?'':'Portfolio status when preparation opened: '+boundStatus+'. Manage the current status in Portfolio.';
  $('submissionCase').textContent=id?'Proposal: '+id:'';
  $('submission').hidden=!id;
}
export function submissionRecord(){
  return 'Submission status (user-set snapshot; not compliance or review approval): '+(portfolioStatus??labels[submissionStatus]);
}
