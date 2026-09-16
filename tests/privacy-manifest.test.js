const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const manifest = fs.readFileSync(path.join(root, 'ios/App/App/PrivacyInfo.xcprivacy'), 'utf8')
const project = fs.readFileSync(path.join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')

test('iOS privacy manifest declares only the Filesystem timestamp reason', () => {
  const categories = [...manifest.matchAll(/<string>(NSPrivacyAccessedAPICategory[^<]+)<\/string>/g)].map(match => match[1])
  assert.deepEqual(categories, ['NSPrivacyAccessedAPICategoryFileTimestamp'])
  assert.match(manifest, /<string>C617\.1<\/string>/)
  assert.doesNotMatch(manifest, /NSPrivacyTracking|NSPrivacyCollectedDataTypes/)
})

test('iOS app target includes PrivacyInfo.xcprivacy in its Resources phase', () => {
  assert.match(project, /PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference;/)
  const resources = project.match(/\/\* Begin PBXResourcesBuildPhase section \*\/([\s\S]*?)\/\* End PBXResourcesBuildPhase section \*\//)?.[1] || ''
  assert.match(resources, /PrivacyInfo\.xcprivacy in Resources/)
})
