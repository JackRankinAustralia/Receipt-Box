const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadApp } = require('./load-app')

const free = (overrides={}) => ({
  plan: 'free',
  ocr: { used: 0, limit: 25, allowed: true },
  capabilities: { run_ocr: true, create_entity: false, create_project: true, custom_categories: false, advanced_reports: false, export_csv: false, export_pdf: false },
  ...overrides
})

test('central entitlement service exposes Free usage and locked report/export states', () => {
  const app = loadApp()
  app.setEntitlementFixture(free({ocr:{used:18,limit:25,allowed:true}}))
  assert.match(app.element('accountMsg').innerHTML,/18 of 25 OCR scans used/)
  assert.equal(app.element('advancedReportsLock').classList.contains('hidden'),false)
  app.call('exportReportCSV')
  assert.equal(app.element('detailTitle').textContent,'Receipt Box Pro')
  assert.match(app.element('detailBody').innerHTML,/A\$3\.99/)
  assert.match(app.element('detailBody').innerHTML,/A\$29\.99/)
  assert.match(app.element('detailBody').innerHTML,/Coming Soon/)
})

test('Free creation checks use the central service while existing values remain available', async () => {
  const app = loadApp()
  app.setBackend({ from() { throw new Error('Free lock should stop before a table write') } })
  app.setSettings({entities:[{id:'legacy-1',name:'Legacy Entity',is_archived:false}],categories:[{id:'legacy-2',name:'Historical Custom',is_archived:false}],projects:[{id:'legacy-3',name:'Legacy Project',is_archived:false}]})
  app.setEntitlementFixture(free())
  app.element('newEntity').value='Another entity'
  assert.equal(await app.call('addSetting','entities'),false)
  assert.match(app.element('detailBody').innerHTML,/multiple Entities/)
  app.call('renderSettingChoices')
  assert.match(app.element('entity').innerHTML,/Legacy Entity/)
  assert.match(app.element('category').innerHTML,/Historical Custom/)
  assert.match(app.element('project').innerHTML,/Legacy Project/)
})

test('Free Category rename shows Pro before any custom-name database write', async () => {
  const writes=[]
  const app=loadApp()
  app.setBackend({from(table){return{update(values){writes.push([table,values]);return{async eq(){return{error:null}}}}}}})
  app.setSettings({entities:[],categories:[{id:'category-1',name:'Fuel',is_archived:false,is_default:false},{id:'category-2',name:'Historical Custom',is_archived:false,is_default:false}],projects:[]})
  app.setEntitlementFixture(free())
  assert.equal(await app.call('renameSetting','categories','category-2','Client Entertainment'),false)
  assert.equal(writes.length,0)
  assert.equal(app.element('detailTitle').textContent,'Receipt Box Pro')
  assert.match(app.element('detailBody').innerHTML,/custom Categories/)
  await app.call('renameSetting','categories','category-1','Travel')
  assert.deepEqual(JSON.parse(JSON.stringify(writes)),[['categories',{name:'Travel',updated_at:'2026-08-18T02:00:00.000Z'}]])
})

test('OCR session RPCs carry one opaque session ID and meaningful-result status', async () => {
  const calls=[]
  const app=loadApp()
  app.setBackend({async rpc(name,args){calls.push([name,args]);if(name==='begin_ocr_scan')return{data:{allowed:true},error:null};if(name==='complete_ocr_scan')return{data:{counted:args.has_meaningful_fields},error:null};return{data:free(),error:null}}})
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const admission=await app.beginOCR(id)
  assert.equal(admission.allowed,true)
  await app.completeOCR(id,true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(0,2))),[
    ['begin_ocr_scan',{scan_session_id:id}],
    ['complete_ocr_scan',{scan_session_id:id,has_meaningful_fields:true}]
  ])
})

test('production frontend contains no plan-changing or entitlement-override path', () => {
  const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8')
  assert.doesNotMatch(html,/localStorage[^\n]*(?:plan|entitlement)|[?&](?:plan|pro|entitlement)=/i)
  assert.doesNotMatch(html,/from\(['"]user_entitlements['"]\)\.(?:insert|update|upsert|delete)/)
  assert.doesNotMatch(html,/setEntitlementFixture|__testEntitlement/)
  assert.match(html,/get_my_entitlement/)
  assert.match(html,/begin_ocr_scan/)
  assert.match(html,/complete_ocr_scan/)
})

test('migration keeps entitlement mutation server-only and documents client OCR trust boundary', () => {
  const sql=fs.readFileSync(path.join(__dirname,'..','supabase','migrations','20260821150000_add_free_pro_entitlements.sql'),'utf8')
  assert.match(sql,/revoke all privileges on public\.user_entitlements from anon, authenticated/i)
  assert.match(sql,/grant select on public\.user_entitlements, public\.ocr_scan_sessions to authenticated/i)
  assert.doesNotMatch(sql,/grant (?:insert|update|delete)[^;]*user_entitlements[^;]*authenticated/i)
  assert.match(sql,/pg_advisory_xact_lock/)
  assert.match(sql,/status in \('started','succeeded'\)/)
  assert.match(sql,/has_meaningful_fields/)
})
