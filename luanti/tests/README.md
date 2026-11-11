# 内容审计（L1 静态 + L2 配方）

```bash
bash luanti/scripts/audit.sh "E:/MinecraftOffline/游戏/方块世界-Luanti"
# 报告：artifacts/audit/audit.txt
```

## 现在检查什么

| 检查 | 说明 |
| --- | --- |
| items / nodes / entities / tools / foods | 注册表基数 |
| smeltable | 可熔炼物品数，并校验产出物存在 |
| recipes_ok / recipes_bad | 对每条配方调用 `get_craft_result` 实算，输出必须等于目标物品 |
| recipes_group_skipped | 含 `group:` 的配方跳过（引擎按组匹配，静态无法枚举） |
| item_no_description | 无描述（含内部节点，需分诊） |
| item_no_image | 无图标（同上） |
| node_no_sounds | 节点无音效（应为 0） |
| tool_no_uses | 工具无耐久字段（药水/剪刀/盾等特殊工具有误报） |
| food_no_saturation | 有 food 组但无 `_mcl_saturation`（药水/牛奶有误报） |
| entity_no_texture | 实体无贴图（应为 0） |

## 判定

报告首部 `verdict=PASS` 的条件：`recipes_bad == 0` 且 `node_no_sounds == 0` 且 `entity_no_texture == 0`。
其余计数是"待分诊样本"，不等于缺陷。

## 已覆盖（v2）

- 钓鱼掉落表（4 张表，34 条）
- 村民交易（11 职业，592 条；先调用 `mcl_enchanting.initialize()` 避免附魔变体误判）
- 附魔表（39 条，含不兼容项引用检查）
- 配方实算（1375 条通过，189 条含 group: 跳过）

## 还没做（下一步）

- 过滤内部节点（`light_*`、`*_top`、`*_wall`、`ignore`）后再统计
- 工具耐久改用真实字段（`_mcl_durability` / `tool_capabilities.max_uses`）
- 食物只统计 `mcl_farming` / `mcl_food` 命名空间
- 酿造 / 附魔 / 交易 / 钓鱼掉落表的逐条校验
- 贴图文件存在性（需要遍历 mod 目录，Lua 侧要另写）
