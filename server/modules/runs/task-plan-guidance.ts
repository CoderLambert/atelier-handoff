/**
 * @file Defines model-facing guidance for grounded task plans.
 * @implementation Gives the existing run and plan tool consistent rules for scope, verification and corrections.
 * @updated 2026-11-28T18:57:00+08:00
 */
export const taskPlanGuidance = [
  '任务清单：复杂任务核实必要事实后先用 update_plan 记录，再开始实质工作。单步问题在回复中直接给答案，不写清单。例如一句话翻译直接回复译文。',
  '用用户的语言写清单。先从本轮请求和已确认的上下文提取交付物、限制及完成条件，按需只读核实会影响拆解的文件或事实。',
  '已有材料足以交付时直接安排任务。关键材料缺失时，只追问继续所需的材料或决定；能独立开展的部分可继续。可逆的命名和样式用合理默认，未经用户要求的替代交付不拿来做阻塞选项。',
  '每条写清动作、对象和可检查的结果，按实际依赖排序。用户要求先只读时，只安排允许的调查和汇报。逐条核对引用的文件名和完整路径，沿用当前有效的资料；已明确缺失的材料记为缺口，已废弃的资料不列为待查来源。',
  '保留明确指定的交付格式和验证场景。用户同时要求生成文件和验证时，清单应写出生成、实际检查、交付的顺序。例如“生成单文件 HTML；打开并核对指定的浏览或打印场景，交付 HTML 原件”。仅配置支持某个场景还不等于检查过。确实缺工具或权限时，写清缺少的条件。',
  '提交前双向核对：每项明确要求都有对应步骤，每个步骤都有需求或必要验证作为依据。项目经历、指标和原因只写材料能证实的部分；缺少对比基线就只说明可核实的数据和缺口。用可检查的结果合并重复动作。',
  '用户中途修正要求或发现新事实时，只调整受影响的步骤并提交整份更新后的清单，移除已取消的工作。只在实际工具或检查给出结果之后标记完成，不提前宣称已读取、已验证或已交付。',
].join('\n');

export const taskPlanToolDescription =
  'Record or replace the task checklist when multi-step work benefits from tracking. ' +
  'Write each step as a concrete action with an observable completion check. ' +
  'Cover all explicit requirements and only work supported by the request or needed to verify the deliverable. ' +
  'Update affected steps when requirements change and mark a step complete after verifying its result. ' +
  'This does not grant permissions.';
