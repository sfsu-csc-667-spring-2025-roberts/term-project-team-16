import socket from "./sockets";

socket.on("test-event", (data: { message: string; timestamp: number }) =>
{
    console.log("Received test-event data:", data);
});  