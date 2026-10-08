// READ-ONLY discovery: find pawgen's ECS service + task definition and print
// its env/secrets WIRING (names + secret ARNs only — never values), so the
// Mailgun staging script can target the right secret JSON. Run from
// ops-dashboard (it has @aws-sdk deps): node scripts/find-pawgen-taskdef.mjs
import { createRequire } from 'node:module';
const req = createRequire('/Users/paul/Projects/ops-dashboard/noop.js');
const { ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand } = req('@aws-sdk/client-ecs');

const ecs = new ECSClient({ region: 'us-east-1' });
const { clusterArns } = await ecs.send(new ListClustersCommand({}));
for (const cluster of clusterArns ?? []) {
  const { serviceArns } = await ecs.send(new ListServicesCommand({ cluster, maxResults: 100 }));
  if (!serviceArns?.length) continue;
  const { services } = await ecs.send(new DescribeServicesCommand({ cluster, services: serviceArns }));
  for (const s of services ?? []) {
    if (!/pawgen/i.test(s.serviceName) && !/pawgen/i.test(s.taskDefinition ?? '')) continue;
    console.log(`cluster: ${cluster.split('/').pop()}`);
    console.log(`service: ${s.serviceName}`);
    console.log(`taskDefinition: ${s.taskDefinition}`);
    const td = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: s.taskDefinition }))).taskDefinition;
    for (const cd of td.containerDefinitions ?? []) {
      console.log(`container: ${cd.name}`);
      console.log(`  plain env names: ${(cd.environment ?? []).map((e) => e.name).join(', ') || '(none)'}`);
      for (const sec of cd.secrets ?? []) console.log(`  secret ref: ${sec.name} <- ${sec.valueFrom}`);
    }
  }
}
console.log('done');
