// A detached `git gc --auto` or maintenance run can outlive a test and race the removal of its repo
// (`ENOTEMPTY` on .git/objects). Every git the tests start inherits these settings, so none starts.
const config: [string, string][] = [
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
];
const have = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
config.forEach(([k, v], i) => {
  process.env[`GIT_CONFIG_KEY_${have + i}`] = k;
  process.env[`GIT_CONFIG_VALUE_${have + i}`] = v;
});
process.env.GIT_CONFIG_COUNT = String(have + config.length);
