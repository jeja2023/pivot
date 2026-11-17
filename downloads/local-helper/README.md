# 独立助手下载文件

此目录由主应用的 `/downloads/local-helper/` 提供下载，并随现有 `downloads` 持久化目录挂载。

在 Windows 构建机执行 `npm run build:local-helper` 后，执行 `npm run publish:local-helper`。受控验证包可使用 `npm run build:local-helper -- --unsigned` 构建，发布入口会保留“开发验证版（未签名）”标识。

发布命令从 `dist-local-helper/latest-build.json` 读取构建记录，校验文件名、版本、文件类型和 SHA-256，复制安装包并更新 `latest.json`。同名且内容不同的文件拒绝覆盖；请提高版本号后重新构建。

部署时将完整的安装包和 `latest.json` 一并复制到服务器同名目录，不要只传元数据。此目录不承载完整桌面客户端的更新元数据，不能覆盖上级 `latest.yml`。安装包和运行时元数据不提交 Git，也不会包含在主应用镜像中。

发布命令只自动创建构建机上的目录。服务器首次部署需在Compose部署目录执行 `mkdir -p downloads/local-helper`，或通过同步工具连同目录一起复制；主应用启动不会自动创建子目录或下载构建制品。当前助手包仍为v0.7.164，主应用源码版本为v0.7.167；两者应按各自实际身份核对。

操作与验证范围见 `docs/deployment/Windows独立本机助手.md` 和 `docs/reports/local-helper-downloads-20261116.md`。
