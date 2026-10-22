using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal sealed class Config
{
    public string pipeName { get; set; }
    public string nodePath { get; set; }
    public string brokerScript { get; set; }
    public string configPath { get; set; }
}

internal static class Program
{
    private const int MaxBrowserMessage = 64 * 1024 * 1024;

    private static string Escape(string value)
    {
        return new JavaScriptSerializer().Serialize(value ?? "");
    }

    private static Config LoadConfig()
    {
        string home = Environment.GetEnvironmentVariable("ENTERPRISE_BROWSER_MCP_HOME");
        if (String.IsNullOrWhiteSpace(home))
            home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "EnterpriseBrowserMcp");
        string path = Path.Combine(home, "config.json");
        return new JavaScriptSerializer().Deserialize<Config>(File.ReadAllText(path, Encoding.UTF8));
    }

    private static NamedPipeClientStream Connect(Config config)
    {
        for (int attempt = 0; attempt < 2; attempt++)
        {
            var pipe = new NamedPipeClientStream(".", config.pipeName.Replace(@"\\.\pipe\", ""), PipeDirection.InOut, PipeOptions.Asynchronous);
            try
            {
                pipe.Connect(1500);
                return pipe;
            }
            catch
            {
                pipe.Dispose();
                if (attempt > 0) throw;
                var process = new Process();
                process.StartInfo.FileName = config.nodePath;
                process.StartInfo.Arguments = "\"" + config.brokerScript + "\" broker --config \"" + config.configPath + "\"";
                process.StartInfo.UseShellExecute = false;
                process.StartInfo.CreateNoWindow = true;
                process.Start();
                Thread.Sleep(750);
            }
        }
        throw new IOException("Unable to connect to Enterprise Browser MCP Broker");
    }

    private static byte[] ReadBrowserFrame(Stream input)
    {
        byte[] lengthBytes = new byte[4];
        int offset = 0;
        while (offset < 4)
        {
            int read = input.Read(lengthBytes, offset, 4 - offset);
            if (read == 0) return null;
            offset += read;
        }
        int length = BitConverter.ToInt32(lengthBytes, 0);
        if (length <= 0 || length > MaxBrowserMessage) throw new IOException("Invalid Native Messaging frame length");
        byte[] payload = new byte[length];
        offset = 0;
        while (offset < length)
        {
            int read = input.Read(payload, offset, length - offset);
            if (read == 0) throw new EndOfStreamException();
            offset += read;
        }
        return payload;
    }

    private static void WriteBrowserFrame(Stream output, string json)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        byte[] length = BitConverter.GetBytes(payload.Length);
        lock (output)
        {
            output.Write(length, 0, length.Length);
            output.Write(payload, 0, payload.Length);
            output.Flush();
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            Config config = LoadConfig();
            string origin = args.Length > 0 && args[0].StartsWith("chrome-extension://", StringComparison.Ordinal)
                ? args[0]
                : "";
            using (NamedPipeClientStream pipe = Connect(config))
            using (var pipeReader = new StreamReader(pipe, new UTF8Encoding(false), false, 8192, true))
            using (var pipeWriter = new StreamWriter(pipe, new UTF8Encoding(false), 8192, true) { AutoFlush = true })
            {
                pipeWriter.WriteLine("{\"type\":\"hello\",\"role\":\"extension\",\"origin\":" + Escape(origin) + ",\"pid\":" + Process.GetCurrentProcess().Id + "}");
                Stream browserIn = Console.OpenStandardInput();
                Stream browserOut = Console.OpenStandardOutput();
                Exception outputError = null;
                var outputThread = new Thread(() =>
                {
                    try
                    {
                        string line;
                        while ((line = pipeReader.ReadLine()) != null) WriteBrowserFrame(browserOut, line);
                    }
                    catch (Exception error) { outputError = error; }
                });
                outputThread.IsBackground = true;
                outputThread.Start();

                byte[] frame;
                while ((frame = ReadBrowserFrame(browserIn)) != null)
                    pipeWriter.WriteLine(Encoding.UTF8.GetString(frame));
                if (outputError != null) throw outputError;
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
