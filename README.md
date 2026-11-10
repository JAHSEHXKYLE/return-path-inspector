# 回流路径检查 · Return Path Inspector

面向嘉立创 EDA 专业版的 PCB 扩展。选择起始点和流入点，查看同网铜箔上可通过的路线、换层位置和几何长度。

**当前版本 v0.1.20** · 适用目标为 Windows 上的嘉立创 EDA 专业版 V4.1。构建与测试无需安装第三方依赖。

## 安装和使用

1. 在 [Releases](https://github.com/JAHSEHXKYLE/return-path-inspector/releases) 下载 `return-path-inspector_v0.1.20.eext`，或按下方步骤从源码构建。
2. 在 EDA 打开 **高级 → 扩展管理器 → 导入**，选择扩展包并启用。
3. 打开 **回流路径 → 单对点检查**，依次选择起始点与流入点。也可以在 **多对点检查** 中采集多组端点，分开检查或按合计长度排序。
4. 从结果列表选择路线。工作区和示意图高亮同一条路线，工作区默认显示最短候选，线宽默认为 8 mil。

[完整使用指南](docs/guide.md) · [版本记录](CHANGELOG.md)

## 功能

- 支持同网、同板框校验，识别走线、焊盘、普通过孔和可读取的实心覆铜。
- 结合铜层叠层计算换层长度。无法读取叠层时，可输入手动深度或按板厚估算。
- 支持复杂铺铜绕行、铜区边界内的倒角和相近路线合并。
- 路线列表、示意图及非铜预览层联动。工作区线宽可设为 0.2–50 mil。
- 提供进度、取消和原生 EDA 日志。扩展可在 EDA 的外部交互权限关闭时使用。

这里的长度基于可读取的铜箔几何。复杂铜区的最短结果是搜索得到的候选近似值。高频回流分布和阻抗需要电气模型。保存 PCB 时，非铜预览图元可随设计保存，归档前可通过扩展清除。

## 构建和测试

使用 **Node.js 22+** 和 **Python 3.10+**。

```sh
node --test test/popup.test.cjs test/return-path.test.cjs
python build.py
```

构建结果位于 `build/dist/return-path-inspector_v0.1.20.eext`。GitHub Actions 在 Windows 环境中运行测试和打包。推送与 `extension.json` 版本匹配的 `v` 标签后，构建通过的 `.eext` 会发布到 Releases。

| 路径 | 用途 |
| --- | --- |
| `src/` | 铜箔几何与路径求解、EDA 接口适配、扩展入口 |
| `iframe/` | 结果界面与选点提示 |
| `test/` | 求解器、界面和 EDA 接口模拟回归 |
| `build.py` | 读取扩展版本并构建 `.eext` |
| `docs/guide.md` | 配置、使用和已知限制 |
