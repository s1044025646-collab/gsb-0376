// 演示: 四种旋转 + 含重复键与双子节点的连续删除
import { SetService } from './service';
import { renderLog, renderTree } from './render';

export async function runDemo(service: SetService): Promise<void> {
  const groups: { name: string; keys: number[]; expect: string }[] = [
    { name: 'LL (右旋)', keys: [30, 20, 10], expect: 'LL' },
    { name: 'RR (左旋)', keys: [10, 20, 30], expect: 'RR' },
    { name: 'LR (先左旋后右旋)', keys: [30, 10, 20], expect: 'LR' },
    { name: 'RL (先右旋后左旋)', keys: [10, 30, 20], expect: 'RL' },
  ];
  console.log('===== 第一部分: 四组三键触发四种旋转 =====');
  for (const g of groups) {
    const { setId } = service.createSet(`demo-${g.expect}`);
    console.log(`\n--- ${g.name}: 依次插入 ${g.keys.join(', ')} (集合 ${setId}) ---`);
    for (const k of g.keys) console.log(renderLog(service.insert(setId, k)));
    console.log(renderTree((service as any).getTree(setId).root));
  }

  console.log('\n===== 第二部分: 含重复键与双子节点的连续删除 =====');
  const { setId } = service.createSet('demo-delete');
  const keys = [50, 30, 70, 20, 40, 60, 80, 40, 40, 60, 35, 35, 35];
  console.log(`插入: ${keys.join(', ')} (集合 ${setId})`);
  for (const k of keys) service.insert(setId, k);
  console.log(renderTree((service as any).getTree(setId).root));
  const dels = [40, 40, 40, 35, 35, 35, 50, 30, 70, 60, 20, 80, 60, 999];
  console.log(`\n连续删除: ${dels.join(', ')}`);
  for (const k of dels) {
    const log = service.delete(setId, k);
    console.log(renderLog(log));
    console.log(renderTree((service as any).getTree(setId).root));
  }
  console.log('\n演示完成。');
}
