export async function deleteAccountResources({ listPaths, removePaths, cleanupData, deleteAuth }) {
  const paths = await listPaths()
  if (paths.length) await removePaths(paths)
  await cleanupData()
  await deleteAuth()
  return true
}
