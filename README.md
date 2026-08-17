# Cube

Cube là coding agent tương tác chạy trong terminal. Project được tổ chức thành bốn package có trách nhiệm tách biệt: workspace lưu cấu hình toàn cục, agent cung cấp runtime headless, TUI chỉ hiển thị và phát action, còn CLI ghép các phần này thành ứng dụng hoàn chỉnh.

## Cấu trúc package

- `cube-workspace` sở hữu layout `~/.cube`, các bootstrap template, config/SOUL validation, workspace identity và đường dẫn runtime được cấp theo phạm vi hẹp.
- `cube-agent` tạo Mastra agent runtime và sở hữu các file memory/log runtime; package cung cấp Session, model catalog, memory finalization cùng lifecycle đóng runtime.
- `cube-tui` dựng giao diện pi-tui, render trạng thái và phát các action có kiểu rõ ràng; package này không biết Mastra hay workspace config.
- `cube-cli` là executable composition root: load môi trường, tạo workspace/runtime/TUI, đăng ký slash command, route action và quản lý shutdown.

Dependency chính:

```text
cube-workspace <- cube-agent <- cube-cli -> cube-tui
       ^                         |
       +-------------------------+
```

CLI dùng trực tiếp workspace để đọc và ghi cấu hình; TUI không phụ thuộc vào các package Cube khác.

## Luồng giao tiếp

Khi khởi động, CLI load `.env`, khởi tạo Cube home, đọc cấu hình và workspace identity, sau đó tạo một agent runtime và một TUI. Runtime không được tạo chỉ vì package agent được import.

Prompt và slash command đều bắt đầu từ editor nhưng được TUI phát thành action riêng. Với prompt, CLI yêu cầu runtime chuẩn bị thread: system prompt được đọc từ `SOUL.md`, snapshot đúng một lần vào setting của thread rồi được agent runtime dùng xuyên suốt thread đó. CLI chuyển command đến registry; mỗi command có handler độc lập. `/model` lấy catalog, mở picker qua TUI, switch model ở Session rồi ghi model mới về `config.yaml` toàn cục.

CLI đăng ký đúng một subscription với Session. Các event streaming, tool và model được chuyển thành lời gọi render có tên rõ ràng trên TUI. Khi Session phát `tool_approval_required`, CLI mở picker inline của TUI rồi gọi trực tiếp API approval của Session để tiếp tục hoặc từ chối chạy tool.

Ctrl+C hủy lượt agent đang chạy; khi không có lượt chạy, nó shutdown ứng dụng. `/exit` và SIGTERM dùng chung lifecycle đóng TUI và runtime, đồng thời khôi phục kiểu terminal cursor.

## Phát triển

Yêu cầu Node.js `>=22.13.0` và pnpm.

```bash
pnpm install
pnpm dev
pnpm --recursive --if-present test
pnpm typecheck
pnpm build
```

## License

MIT License.
