// Frozen P1 quantity facts accept character/organization subjects, not item subjects.
// Use the shared owner's organization key, retaining the reviewer's resource name.
export const sharedAccounts={
 'item:expedition_water_supply':{subject:'org:expedition',description:'The expedition’s jointly used water account.'},
 'item:team_travel_fund':{subject:'org:relay_team',description:'The relay team’s jointly used travel account.'},
 'item:exhibition_petty_cash':{subject:'org:exhibition',description:'The exhibition’s petty-cash account.'}
};
export function normalizeSharedAccount(label){
 const account=sharedAccounts[label.subject];
 return account?{...label,subject:account.subject,sharedResourceKey:label.subject,subjectNamespaceNote:'The reviewed item name identifies the shared resource. P1 quantity subjects require char/org, so the actual subject is the shared organization, never the individual custodian.'}:label;
}
