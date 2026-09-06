import ws from "k6/ws";
import { check, sleep } from "k6";

export const options = {
  vus: 20,
  duration: "30s",
  thresholds: {
    ws_connecting: ["p(95)<1000"],
    ws_session_duration: ["p(95)<31000"]
  }
};

export default function () {
  const url = __ENV.SIM_SERVER_WS_URL || "ws://localhost:8080";

  const response = ws.connect(url, {}, function (socket) {
    let messageCount = 0;

    socket.on("open", () => {
      socket.setInterval(() => {
        socket.send(
          JSON.stringify({
            type: "input",
            ts: Date.now(),
            payload: { carId: "car_unclaimed", throttle: 1, brake: 0, steer: 0, inputMethod: "keyboard" }
          })
        );
      }, 100);
    });

    socket.on("message", () => {
      messageCount++;
    });

    socket.setTimeout(() => {
      socket.close();
    }, 10000);

    socket.on("close", () => {
      check(messageCount, { "received at least one broadcast": (n) => n > 0 });
    });
  });

  check(response, { "connected (HTTP 101)": (r) => r && r.status === 101 });
  sleep(1);
}
