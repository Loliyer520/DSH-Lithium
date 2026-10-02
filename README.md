# DSH-Lithium（锂）

为 DeepSeek Harness（DSH）的工具调用提供优化，并参考各个开源优化项目进行功能整合与协同兼容适配。

一个模块化的 DSH Host 插件：把「重复输入的 shell 长命令」沉淀为带参数的命名别名，在工具层面检测重复、主动提示，并提供面向用户与模型两侧的管理入口。

> 本项目以 [LGPL-3.0](LICENSE) 发布。图标复用自 Minecraft mod [Lithium（CaffeineMC）](https://github.com/CaffeineMC/lithium-fabric)，其同样遵循 LGPL-3.0 许可，详见 [NOTICE](NOTICE)。

## 功能模块

插件由若干独立模块组成，每个都可在插件配置中单独开关（见下方「配置」）：

| 模块 | 说明 |
| --- | --- |
| `aliases` | `command_alias` 工具（增删查别名）+ `run_command` 工具（执行前展开别名）；支持参数化、双作用域、文本预字符串、审批守卫 |
| `promptSection` | 动态系统提示词段落：向模型告知当前别名清单与用法规则（仅列全局别名，跨会话稳定，不伤害提示词缓存） |
| `repeatDetector` | 监听 shell 工具结果，同一长前缀第 2 次出现时在结果里追加「建议存为别名」提示 |
| `slashCommand` | 注册 `/alias` 用户斜杠命令，直接在输入框管理别名，无需消耗模型轮次 |

集成组件：`dsh-ptc-plus`（[muyuanjin/dsh-ptc-plus](https://github.com/muyuanjin/dsh-ptc-plus)，会话级 TypeScript REPL，PTC 模式下生效）。它在 `package.json` 中被声明为依赖、并由 `cordis.patch.yml` 插入其行，因此**安装 dsh-lithium 时会自动一并安装并激活**，无需单独安装。

## 安装

```sh
dsh plugin --profile <profile> add <本目录或 npm 包名>
```

安装后重启 DSH（新建 bundle 通常可通过 HMR 即时生效）。

## 用法

### 定义别名

由模型调用：

```
command_alias(action="set", name="remote_shell",
  expansion="sshpass -p '…' ssh -o StrictHostKeyChecking=no user@192.168.1.10",
  description="SSH 到生产服务器")
```

或在输入框直接（用户侧，不经过模型）：

```
/alias set remote_shell sshpass -p '…' ssh -o StrictHostKeyChecking=no user@192.168.1.10
```

### 使用别名

```
run_command(command='remote_shell "df -h"', description='查看远程磁盘')
```

`run_command` 与 `pwsh` 参数一致，但会先把 `command` 中的独立别名记号替换为存储的完整串再执行；展开串（可能含密码）不会出现在系统提示词、会话日志或 UI 卡片中。

### 参数化别名

展开串可含 `<name>` 或 `<name=默认值>` 占位符：

```
command_alias(action="set", name="deploy",
  expansion='sshpass -p x ssh u@h "cd /app && ./deploy.sh <env=prod> <branch>"')
```

```
run_command(command='deploy branch=feature-x', description='部署')
# → ./deploy.sh prod feature-x
```

缺少必填参数或参数名拼写错误都会返回带参数清单的明确报错。

### 作用域

- `global`（默认）：profile 级，所有项目共享
- `workspace`：`<工作区>/.dsh/command-aliases.json`，项目级，同名时覆盖全局

### 文本预字符串

`kind="text"` 的别名不在 `run_command` 中展开，模型用 `command_alias(action="get")` 取用其内容，作为提示词/文本片段。

### 审批守卫

`confirm: true` 的别名在执行前会通过 `tools/pre-execute` 触发用户审批。

## 配置

插件行 `config` 支持：

```yaml
storagePath: '<全局别名存储绝对路径>'   # 可选，默认 %DSH_PROFILE_DIR%/command-aliases.json
shellTools: ['pwsh', 'bash']            # run_command 的委托顺序
modules:
  aliases: true
  promptSection: true
  repeatDetector: true
  slashCommand: true
repeatDetector:
  minPrefixChars: 24
  prefixTokens: 3
  threshold: 2
```

## 目录结构

```
index.js                 # 入口：模块加载器 + 配置
modules/
  store.js               # 别名存储、作用域合并、参数化展开（共享）
  aliases.js             # command_alias / run_command 工具 + 审批守卫 + 提示词段落
  repeat-detector.js     # 重复指令检测
  slash-command.js       # /alias 用户命令
locale/                  # 显示名与介绍（zh / en）
cordis.patch.yml         # Loader patch
smoke-test.mjs           # 本地冒烟测试（mock Cordis 上下文）
```

## 开发

```sh
node smoke-test.mjs     # 全部模块的本地自测
node --check index.js   # 语法检查
```
