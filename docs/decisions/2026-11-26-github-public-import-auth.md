# 公开 Skill 导入使用本机 GitHub CLI 登录

## 问题与选择

批量查询公开仓库触发了 GitHub 的 IP 额度，实测未认证请求每小时 60 次。本机 GitHub CLI 已登录并由系统钥匙串持有凭据。用户要求在 Atelier 接入 GitHub 认证。

[GitHub REST 限额](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) 对一般已认证用户提供每小时 5,000 次额度。[OAuth 设备流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) 需要 GitHub 上已注册且启用该流程的应用；无 scope 可读取公开信息。当前选择复用 [GitHub CLI 登录](https://cli.github.com/manual/gh_auth_login) 和 [gh api](https://cli.github.com/manual/gh_api)，让现有凭据管理和授权页继续由 GitHub CLI 持有。Atelier 中的连接动作明确启用这一路径。

## 限定使用面

SQLite 只记连接的账号名。运行时只用 `gh api --method GET` 读取账号名、核对仓库公开性、读取项目安装所需的提交与 Git 树。响应中只转发预览用的状态、限额头和 JSON，文件字节仍从公开 raw 地址按固定提交读取。应用不会请求或保存 token，断开连接只移除 Atelier 偏好。若 CLI 未登录，可以通过官方登录流程建立本机凭据后再连接。

## 验证与回退

验证未连接时仍可不登录导入，连接后对公开仓库查询使用认证额度，私有仓库被拒绝。真实账号验证只读接口，模拟测试覆盖断开与错误。回退删除此连接键和 CLI 读取路径，现有项目技能包保持可用。
