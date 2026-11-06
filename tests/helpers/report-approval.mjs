import {createSeedState,applyAction,PROJECT_APPROVAL_LABELS} from '../../public/domain.mjs';
import {currentReportStage} from '../../public/report-approval.mjs';

/** Real approval configuration used by business-rule test fixtures. */
export function configureReportProjects(state,reviewerId='manager'){
  for(const project of state.projects){
    project.projectCode ||= 'TEST-'+project.id;
    project.projectManagerId=reviewerId;
    project.reviewChain=PROJECT_APPROVAL_LABELS.map(label=>({label,userId:reviewerId}));
  }
  return state;
}
export const reportSeed=()=>configureReportProjects(createSeedState());
export function reviewReportStep(state,id,status='approved',reviewNote=''){
  const report=state.reports.find(row=>row.id===id),project=state.projects.find(row=>row.id===report?.projectId);
  const actor=currentReportStage(report,project)?.userId||project?.projectManagerId||'manager';
  return applyAction(state,actor,'report.review',{id,version:report.version,status,reviewNote});
}
export function advanceReportToFinal(state,id,reviewNote=''){
  for(let step=0;step<5;step++)reviewReportStep(state,id,'approved',reviewNote);
}
export function approveReport(state,id,reviewNote=''){
  let result;
  for(let step=0;step<6;step++)result=reviewReportStep(state,id,'approved',reviewNote);
  return result;
}
