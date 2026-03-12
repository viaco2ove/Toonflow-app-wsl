# Toonflow 最新版拉取后修改记录

- 记录时间：2026-03-12 14:13 CST
- 目标仓库：`/mnt/d/Users/viaco/tools/toonflow-app-run`
- 拉取结果：`master` 已同步到 `origin/master`，HEAD 为 `641c980`

## 1. 拉取与本地改动恢复
- 执行 `git fetch --all --prune` 后确认本地落后 25 个提交。
- 执行 `git pull --ff-only origin master` 完成快进更新。
- 因本地有未提交改动，使用 `stash` 保护并恢复；冲突处理后保留本地业务改动，保持可继续开发状态。

## 2. 启动报错修复（模块缺失）
- 问题：`Cannot find module 'qwen-ai-provider'`
- 原因：代码引用 `qwen-ai-provider`，但依赖为 `qwen-ai-provider-v5`
- 修改文件：`src/utils/ai/text/modelList.ts`
- 修复：导入改为 `import { createQwen } from "qwen-ai-provider-v5";`
- 验证：`yarn dev:gui` 启动链路不再报该模块缺失错误。

## 3. 分镜数据清理（按需求执行）
- 操作库：`/home/viaco/.config/Electron/db.sqlite`（GUI 实际使用库）
- 删除内容：
  - `t_assets` 中 `type='分镜'`：44 条
  - `t_image` 中 `type='分镜'`：122 条
  - 上传目录分镜文件：160 个
- 备份文件：`tmp/db_backup/db.sqlite.before_delete_storyboard_20260312_124551.bak`

## 4. 启动报错修复（函数不存在）
- 问题：`TypeError: (0 , import_modelList.getModelList) is not a function`
- 原因：`text/index.ts` 使用了 `getModelList()`，但 `modelList.ts` 缺失该命名导出
- 修改文件：`src/utils/ai/text/modelList.ts`
- 修复：
  - 新增 `getModelList` 命名导出
  - 接入 `t_textModel` 动态读取
  - 增加异常回退到静态 `modelList` 的兜底逻辑
- 验证：`yarn dev:gui` 启动阶段不再出现该错误。

## 5. wsl 中文输入问题修复（分镜对话输入框等全部输入框）
安装并配置 fcitx5 + 中文插件，再启动 Toonflow。 
- 问题：输入框无法正常输入中文（IME 回车上屏被拦截）
- 原因：`Enter` 发送逻辑未排除输入法组合态
- 修改文件：`scripts/web/index.html`（当前仓库前端构建产物）
- 修复：在 `keydown` 发送前增加：
  - `event.isComposing` 判断
  - `event.keyCode === 229` 判断
- 验证：`yarn dev:gui` 启动正常，中文输入链路恢复。
安装并配置 fcitx5 + 中文插件，再启动 Toonflow。 
`sudo apt-get update && sudo apt-get install -y fcitx5 fcitx5-chinese-addons fcitx5-frontend-gtk3 fcitx5-frontend-gtk4 fcitx5-frontend-qt5 fcitx5-frontend-qt6 fcitx5-config-qt
`
编写: ~/bin/fcitx5-wsl-start.sh
`  source ~/.profile                                                                                                                                                         
  ~/bin/fcitx5-wsl-start.sh                                                                                                                                                 
  pgrep -a fcitx5                                                                                                                                                           
  fcitx5-remote --check; echo $?  `
Fcitx 5 Configuration (Ubuntu) 增加拼音
![img.png](img.png)

或者直接windows 运行

## 6. 当前状态说明
- 当前为“已同步上游 + 保留本地改动”状态。
- 关键已改文件包含：
  - `src/utils/ai/text/modelList.ts`
  - `scripts/web/index.html`

## 7. 分镜师“共 0 个片段”修复（2026-03-12 15:37 CST）
- 问题现象：
  - 日志反复出现 `获取片段数据: 共 0 个片段`
  - `shotAgent` 无法继续生成分镜
- 根因：
  - `segmentAgent` 有时只输出文本，不调用 `updateSegments`，导致片段未写入内存/持久化
  - `getSegments` 之前仅依赖内存 `this.segments`
  - `chatStoryboard` 启动时历史读取后又被清空，历史恢复失效
- 修改文件：
  - `/mnt/d/Users/viaco/tools/toonflow-app-run/src/agents/storyboard/index.ts`
  - `/mnt/d/Users/viaco/tools/toonflow-app-run/src/routes/storyboard/chatStoryboard.ts`
- 修复内容：
  - 新增片段持久化键：`storyboardSegments:${scriptId}`
  - `getSegments` 空内存时自动尝试加载持久化片段
  - `segmentAgent` 未调用 `updateSegments` 时，从其文本输出自动解析片段并落库
  - 新增历史兜底：若专用片段存储为空，则从 `storyboardAgent` 历史消息里反解析片段并保存
  - 修正历史读取：按 `type='storyboardAgent'` 读取，且不再连接即清空
- 验证：
  - 启动验证：`yarn dev:gui` 启动 35s 无新增报错
  - 逻辑验证：在无内存片段场景下，`getSegments` 可从历史恢复并返回片段（实测恢复 5 个片段）

## 8. WSL 下 Electron `SIGTRAP` 退出修复（2026-03-12 16:00 CST）
- 问题现象：
  - 分镜生成后出现大量 `GLib-GObject: g_object_ref/g_object_unref` 断言日志
  - `electronmon` 提示 `app exited due to signal (SIGTRAP)`
- 修改文件：
  - `/mnt/d/Users/viaco/tools/toonflow-app-run/scripts/main.ts`
- 修复内容：
  - 新增 WSL 检测
  - WSL 下启用兼容参数：禁用 GPU、切换 `use-gl=swiftshader`、强制 `ozone-platform=x11`
  - 修正主窗口端口使用：改为使用 `startServe` 返回端口，不再硬编码 `60000`
- 说明：
  - 该修复属于 WSL/Electron 稳定性兼容，不影响 Windows 原生运行

## 9. 启动即退出 + `napi_throw` 修复（2026-03-12 16:46 CST）
- 问题现象：
  - 启动后马上出现 `[服务已关闭]`
  - 终端出现 `FATAL ERROR: Error::ThrowAsJavaScriptException napi_throw`
- 根因：
  - `BrowserWindow` 仅为局部变量，可能被回收导致窗口关闭，触发 `window-all-closed -> app.quit()`
- 修改文件：
  - `/mnt/d/Users/viaco/tools/toonflow-app-run/scripts/main.ts`
- 修复内容：
  - 新增全局 `mainWindow` 持有窗口引用，避免窗口被提前回收
  - 补充 `closed` 生命周期回收逻辑
  - `createMainWindow` 防重入（已有窗口直接聚焦）
- 验证：
  - 本地启动后日志保留 `[服务启动成功]`，不再立即出现 `[服务已关闭]`
  - 已看到后续业务请求继续进入（例如 `POST /project/getProject`）

## 10. 超时兜底与 WSL 稳定性增强（2026-03-12 17:20 CST）
- 背景：
  - 出现 `TypeError: terminated` + `UND_ERR_BODY_TIMEOUT`
  - 仍有 `GLib-GObject` 断言并伴随 `SIGTRAP`
- 修改文件：
  - `/mnt/d/Users/viaco/tools/toonflow-app-run/src/agents/storyboard/index.ts`
  - `/mnt/d/Users/viaco/tools/toonflow-app-run/scripts/main.ts`
- 修复内容：
  - `invokeSubAgent` 增加统一 `try/catch`，将 `UND_ERR_BODY_TIMEOUT` 转为友好错误，不再把异常直接打爆流程
  - WSL 启动进一步强制 x11 环境变量与 Chromium 参数（禁用 Ozone/Wayland 相关特性）
  - 新增 `SIGTRAP` 捕获日志，避免主进程被该信号直接拉死
  - 分镜图批量生成由并发改为串行，降低 WSL 图形栈与日志高压下的崩溃概率

## 11. `/tmp` 共享内存报错兼容（2026-03-12 17:35 CST）
- 问题现象：
  - Chromium 报错：`Creating shared memory in /tmp/... failed`
  - `Unable to access(W_OK|X_OK) /tmp`
- 修改文件：
  - `/mnt/d/Users/viaco/tools/toonflow-app-run/scripts/main.ts`
- 修复内容：
  - WSL 下将 `TMPDIR/TMP/TEMP` 与 Electron `temp` 路径重定向到 `XDG_RUNTIME_DIR/electron-tmp`
  - 避免 Chromium 共享内存依赖 `/tmp`，降低 WSL 临时目录异常导致的崩溃概率

## 12. 最新运行日志说明（2026-03-12 17:40 CST）
- 观测日志：
  - `org.freedesktop.systemd1.UnitExists: Unit app-org.chromium.Chromium-xxxx.scope was already loaded`
  - `/tmp/.org.chromium.Chromium.*` 共享内存创建失败
- 结论：
  - `UnitExists` 属于 WSL/DBus 环境噪声，通常不影响 Toonflow 业务功能
  - `/tmp` 相关为 Chromium 在 WSL 图形环境下的临时目录/共享内存不稳定，已通过第 11 节的 `TMPDIR` 重定向方案处理
- 状态：
  - 服务可正常启动并接受请求（如 `POST /project/getProject 200`）
  - 后续以“是否仍出现 `SIGTRAP` 退出”作为最终稳定性判据
