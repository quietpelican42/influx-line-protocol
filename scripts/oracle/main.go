// Command oracle drives github.com/influxdata/line-protocol/v2/lineprotocol
// from JSON lines so the TypeScript port can be compared against it.
//
// Input, one JSON object per line on stdin:
//
//	{"op":"decode","b64":"<input bytes>","prec":"ns|us|ms|s","def":"<int64 ns>"}
//	{"op":"encode","prec":"ns","point":{...}}
//
// Output, one JSON object per input line on stdout.
package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"time"

	lp "github.com/influxdata/line-protocol/v2/lineprotocol"
)

type request struct {
	Op    string    `json:"op"`
	B64   string    `json:"b64"`
	Prec  string    `json:"prec"`
	Def   string    `json:"def"`
	Point *encPoint `json:"point"`
}

type encPoint struct {
	Name   string      `json:"name"`
	Tags   [][2]string `json:"tags"`
	Fields [][3]string `json:"fields"` // key, type, value
	TS     *string     `json:"ts"`
}

type entry struct {
	K      string      `json:"k"`
	Name   string      `json:"name,omitempty"`
	Tags   [][2]string `json:"tags,omitempty"`
	Fields [][3]string `json:"fields,omitempty"`
	TS     string      `json:"ts,omitempty"`
	Line   int64       `json:"line,omitempty"`
	Col    int         `json:"col,omitempty"`
	Msg    string      `json:"msg,omitempty"`
	OOR    bool        `json:"oor,omitempty"`
}

type response struct {
	Entries []entry `json:"entries,omitempty"`
	OK      *bool   `json:"ok,omitempty"`
	Out     string  `json:"out,omitempty"`
	Err     string  `json:"err,omitempty"`
}

func precision(s string) lp.Precision {
	switch s {
	case "us":
		return lp.Microsecond
	case "ms":
		return lp.Millisecond
	case "s":
		return lp.Second
	}
	return lp.Nanosecond
}

func decodeEntry(dec *lp.Decoder, prec lp.Precision, def time.Time) (entry, error) {
	e := entry{K: "p", Tags: [][2]string{}, Fields: [][3]string{}}
	name, err := dec.Measurement()
	if err != nil {
		return e, err
	}
	e.Name = string(name)
	for {
		k, v, err := dec.NextTag()
		if err != nil {
			return e, err
		}
		if k == nil {
			break
		}
		e.Tags = append(e.Tags, [2]string{string(k), string(v)})
	}
	for {
		k, v, err := dec.NextField()
		if err != nil {
			return e, err
		}
		if k == nil {
			break
		}
		switch v.Kind() {
		case lp.Float:
			e.Fields = append(e.Fields, [3]string{string(k), "float", strconv.FormatUint(math.Float64bits(v.FloatV()), 16)})
		case lp.Int:
			e.Fields = append(e.Fields, [3]string{string(k), "int", strconv.FormatInt(v.IntV(), 10)})
		case lp.Uint:
			e.Fields = append(e.Fields, [3]string{string(k), "uint", strconv.FormatUint(v.UintV(), 10)})
		case lp.String:
			e.Fields = append(e.Fields, [3]string{string(k), "string", v.StringV()})
		case lp.Bool:
			e.Fields = append(e.Fields, [3]string{string(k), "bool", strconv.FormatBool(v.BoolV())})
		}
	}
	t, err := dec.Time(prec, def)
	if err != nil {
		return e, err
	}
	e.TS = strconv.FormatInt(t.UnixNano(), 10)
	return e, nil
}

func doDecode(r *request) response {
	data, err := base64.StdEncoding.DecodeString(r.B64)
	if err != nil {
		panic(err)
	}
	defNs, err := strconv.ParseInt(r.Def, 10, 64)
	if err != nil {
		panic(err)
	}
	prec := precision(r.Prec)
	def := time.Unix(0, defNs)
	dec := lp.NewDecoderWithBytes(data)
	var res response
	res.Entries = []entry{}
	for n := 0; dec.Next(); n++ {
		if n > 200000 {
			panic("runaway decoder")
		}
		e, err := decodeEntry(dec, prec, def)
		if err != nil {
			var de *lp.DecodeError
			if !errors.As(err, &de) {
				panic(err)
			}
			res.Entries = append(res.Entries, entry{
				K: "e", Line: de.Line, Col: de.Column, Msg: de.Err.Error(),
				OOR: errors.Is(err, lp.ErrValueOutOfRange),
			})
			continue
		}
		res.Entries = append(res.Entries, e)
	}
	return res
}

func doEncode(r *request) response {
	prec := precision(r.Prec)
	p := r.Point
	var e lp.Encoder
	e.SetPrecision(prec)
	e.StartLine(p.Name)
	for _, t := range p.Tags {
		e.AddTag(t[0], t[1])
	}
	for _, f := range p.Fields {
		var v lp.Value
		ok := true
		switch f[1] {
		case "float":
			bits, err := strconv.ParseUint(f[2], 16, 64)
			if err != nil {
				panic(err)
			}
			v, ok = lp.FloatValue(math.Float64frombits(bits))
		case "int":
			x, err := strconv.ParseInt(f[2], 10, 64)
			if err != nil {
				panic(err)
			}
			v = lp.IntValue(x)
		case "uint":
			x, err := strconv.ParseUint(f[2], 10, 64)
			if err != nil {
				panic(err)
			}
			v = lp.UintValue(x)
		case "string":
			v, ok = lp.StringValue(f[2])
		case "bool":
			v = lp.BoolValue(f[2] == "true")
		default:
			panic("bad type " + f[1])
		}
		if !ok {
			bad := false
			return response{OK: &bad, Err: "invalid field value"}
		}
		e.AddField(f[0], v)
	}
	if p.TS == nil {
		e.EndLine(time.Time{})
	} else {
		ns, err := strconv.ParseInt(*p.TS, 10, 64)
		if err != nil {
			panic(err)
		}
		e.EndLine(time.Unix(0, ns))
	}
	ok := e.Err() == nil
	if !ok {
		return response{OK: &ok, Err: e.Err().Error()}
	}
	return response{OK: &ok, Out: string(bytes.Clone(e.Bytes()))}
}

func main() {
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	out := bufio.NewWriterSize(os.Stdout, 1<<20)
	defer out.Flush()
	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	for {
		line, err := in.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var r request
			if uerr := json.Unmarshal(line, &r); uerr != nil {
				fmt.Fprintln(os.Stderr, "bad request:", uerr)
				os.Exit(2)
			}
			var res response
			switch r.Op {
			case "decode":
				res = doDecode(&r)
			case "encode":
				res = doEncode(&r)
			default:
				fmt.Fprintln(os.Stderr, "bad op", r.Op)
				os.Exit(2)
			}
			if eerr := enc.Encode(res); eerr != nil {
				fmt.Fprintln(os.Stderr, "encode:", eerr)
				os.Exit(2)
			}
		}
		if err != nil {
			break
		}
	}
}
