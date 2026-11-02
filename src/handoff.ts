import * as path from 'node:path';
import { Session } from './model';

export function handoffText(root: string, remoteName?: string, session?: Session): string {
  const notes = path.join(root, '.code-review');
  const review = session ? path.join(notes, 'reviews', session.id) : notes;
  const quoted = (file: string): string => JSON.stringify(file);
  return [
    '我已经完成代码 review，请处理这个仓库本轮 CR 的未解决评论。',
    '仓库绝对路径：' + quoted(root),
    '运行位置：' + (remoteName ? '远程工作区（' + remoteName + '）；以下路径属于该远端文件系统。' : '当前电脑的本地文件系统。'),
    ...(session ? ['CR：' + session.id, '所属分支：' + session.branch?.label, '固定基点：' + session.base,
      '先读取 CR 状态：' + quoted(path.join(review, 'REVIEW.json')),
      '如果 CR 已删除或当前检出的分支不符，停止并告诉我；不要自动切分支。'] : []),
    '先读取以下绝对路径，不要根据当前目录或仓库名称猜测项目：',
    '- 处理规则：' + quoted(path.join(notes, 'README.md')),
    '- 待处理清单：' + quoted(path.join(review, 'PENDING.md')),
    '- 原始评论目录：' + quoted(path.join(notes, 'comments')),
    '- 回执目录：' + quoted(path.join(notes, 'replies')),
    '清单内的文件和目录路径均相对于上述仓库根目录，也提供绝对路径。目录评论针对该目录及其子目录的整体问题。路径不存在或项目不匹配时，先向我确认。',
    '只处理本轮待处理清单中的评论 ID，其他 CR 的评论不属于这次任务。结合原代码与上下文确认位置，不能照旧行号修改。',
    '处理后按 README 格式写入 replies/<评论 ID>.json 回执，说明修改与验证；保留原评论，由我复核并标记已解决。'
  ].join('\n');
}
