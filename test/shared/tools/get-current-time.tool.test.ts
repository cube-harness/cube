import { getCurrentTimeTool } from "@/shared/tools/get_current_time.tool.js";

describe("get_current_time tool", () => {
  it("uses the requested IANA time zone", async () => {
    const result = await getCurrentTimeTool.invoke(
      { timeZone: "Europe/London" },
      {
        context: {
          timeZone: "Asia/Ho_Chi_Minh",
          locale: "vi-VN",
        },
      }
    );

    const payload = JSON.parse(result);

    expect(payload.timeZone).toBe("Europe/London");
  });

  it("rejects an invalid IANA time zone", async () => {
    await expect(
      getCurrentTimeTool.invoke(
        { timeZone: "England" },
        {
          context: {
            timeZone: "Asia/Ho_Chi_Minh",
            locale: "vi-VN",
          },
        }
      )
    ).rejects.toThrow('Invalid IANA time zone: "England".');
  });
});
